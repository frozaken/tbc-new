import clsx from 'clsx';
import { ref } from 'tsx-vanilla';

import { IndividualSimUI } from '../../individual_sim_ui';
import { ProgressMetrics, RaidSimResult } from '../../proto/api';
import { GemColor, ItemSlot } from '../../proto/common';
import { UIGem, UIItem as Item } from '../../proto/ui';
import { ActionId } from '../../proto_utils/action_id';
import { EquippedItem } from '../../proto_utils/equipped_item';
import { Gear } from '../../proto_utils/gear';
import { getEmptyGemSocketIconUrl } from '../../proto_utils/gems';
import { Stats } from '../../proto_utils/stats';
import { canEquipItem, getEligibleItemSlots } from '../../proto_utils/utils';
import { RequestTypes } from '../../sim_signal_manager';
import { TypedEvent } from '../../typed_event';
import { SimTab } from '../sim_tab';
import Toast from '../toast';
import GemSelectorModal from './bulk/gem_selector_modal';
import { ItemData } from '../gear_picker/item_list';

// TBC content phases. Selecting a phase is cumulative — phase 2 includes all
// phase 1 items plus the phase 2 ones. Mirrors how players actually gear up.
const PHASES = [1, 2, 3, 4, 5] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABELS: Record<Phase, string> = {
	1: 'Karazhan / Gruul / Magtheridon',
	2: 'Serpentshrine Cavern / Tempest Keep',
	3: 'Mount Hyjal / Black Temple',
	4: "Zul'Aman",
	5: 'Sunwell Plateau',
};

// Used as the "boss" label for items in selected phases that lack a specific
// drop source — typically tier pieces (sourced from vendors / tokens) and
// badge / quest gear.
const PHASE_FALLBACK_BOSS: Record<Phase, string> = {
	1: 'Phase 1 set / badge / quest',
	2: 'Phase 2 set / badge / quest',
	3: 'Phase 3 set / badge / quest',
	4: 'Phase 4 set / badge / quest',
	5: 'Phase 5 set / badge / quest',
};

const ITEM_SLOT_NAMES: Partial<Record<ItemSlot, string>> = {
	[ItemSlot.ItemSlotHead]: 'Head',
	[ItemSlot.ItemSlotNeck]: 'Neck',
	[ItemSlot.ItemSlotShoulder]: 'Shoulder',
	[ItemSlot.ItemSlotBack]: 'Back',
	[ItemSlot.ItemSlotChest]: 'Chest',
	[ItemSlot.ItemSlotWrist]: 'Wrist',
	[ItemSlot.ItemSlotHands]: 'Hands',
	[ItemSlot.ItemSlotWaist]: 'Waist',
	[ItemSlot.ItemSlotLegs]: 'Legs',
	[ItemSlot.ItemSlotFeet]: 'Feet',
	[ItemSlot.ItemSlotFinger1]: 'Finger 1',
	[ItemSlot.ItemSlotFinger2]: 'Finger 2',
	[ItemSlot.ItemSlotTrinket1]: 'Trinket 1',
	[ItemSlot.ItemSlotTrinket2]: 'Trinket 2',
	[ItemSlot.ItemSlotMainHand]: 'Main Hand',
	[ItemSlot.ItemSlotOffHand]: 'Off Hand',
	[ItemSlot.ItemSlotRanged]: 'Ranged',
};

// Wowhead's TBC item tooltip + icon CDN. data-whtticon="false" prevents
// Wowhead's tooltip script from injecting its own icon (we render our own).
const itemHref = (itemId: number) => `https://www.wowhead.com/tbc/item=${itemId}`;
const itemIconUrl = (iconName: string) => `https://wow.zamimg.com/images/wow/icons/medium/${iconName}.jpg`;

const fmtDps = (v: number) => v.toFixed(1);
const fmtDelta = (v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const deltaClass = (v: number) => (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : 'text-muted');

function renderItemLink(item: Item): HTMLElement {
	return (
		<a
			className="droptimizer-item-link"
			href={itemHref(item.id)}
			target="_blank"
			rel="noopener"
			dataset={{ whtticon: 'false' }}>
			{item.icon && <img className="droptimizer-item-icon" src={itemIconUrl(item.icon)} alt="" />}
			<span className="droptimizer-item-name">{item.name}</span>
		</a>
	) as HTMLElement;
}

// Welford combiner: merges two samples (n, mean, stdev) into a single
// equivalent sample with the same per-iteration statistical content. Used to
// accumulate Smart Sim passes without throwing away earlier iterations.
// Reference: https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance#Parallel_algorithm
function combineSamples(
	a: { n: number; mean: number; stdev: number },
	b: { n: number; mean: number; stdev: number },
): { n: number; mean: number; stdev: number } {
	if (a.n === 0) return b;
	if (b.n === 0) return a;
	const n = a.n + b.n;
	const delta = b.mean - a.mean;
	const mean = (a.n * a.mean + b.n * b.mean) / n;
	const M2_a = (a.n - 1) * a.stdev * a.stdev;
	const M2_b = (b.n - 1) * b.stdev * b.stdev;
	const M2 = M2_a + M2_b + (delta * delta * a.n * b.n) / n;
	const variance = n > 1 ? M2 / (n - 1) : 0;
	return { n, mean, stdev: Math.sqrt(variance) };
}

// Order of fallback gem pickers in the settings panel.
const FALLBACK_GEM_COLORS: GemColor[] = [
	GemColor.GemColorRed,
	GemColor.GemColorYellow,
	GemColor.GemColorBlue,
	GemColor.GemColorMeta,
	GemColor.GemColorPrismatic,
];

// Drop a candidate if its EP (computed from the player's stat weights) is
// more than this fraction below the equipped item's EP. Generous: 15% lets
// items with weaker raw stats but plausible procs / set bonuses through.
const EP_PREFILTER_TOLERANCE = 0.15;

// Smart Sim pass configuration — *cumulative* iteration budgets per item.
// Each pass runs (budget − currentIters) more iters and combines results via
// Welford's online combiner, so no work is thrown away. After every pass we
// re-test each item against the baseline and early-terminate the decisive
// ones. The final pass uses the sim's configured iteration count.
const SMART_SIM_PASS_BUDGETS = [100, 300, 1000, 3000];
// Always keep at least this many candidates undecided after each pass, even if
// the statistical rule would resolve more. Guards against RNG-driven false
// classifications at low iteration counts.
const MIN_UNDECIDED_AFTER_PASS = 10;
// One-sided z-score for p = 0.05. After each pass, an item's delta-vs-baseline
// confidence interval is checked against zero in both directions:
//   delta - z * combinedSEM > 0  → confirmed upgrade, stop simming further
//   delta + z * combinedSEM < 0  → confirmed not-an-upgrade, cull
//   otherwise                    → still uncertain, keep simming next pass
const DECISIVE_Z_SCORE = 1.645;

// Floor on iterations before an item can be marked 'confirmed'. The z-test
// can resolve "this is an upgrade" at 100 iters, but the +ΔDPS *point estimate*
// is still noisy at that count. Holding confirmation until at least this many
// iterations keeps the displayed gain credible.
const MIN_ITERS_FOR_CONFIRMATION = 1000;

interface DroptimizerCandidate {
	item: Item;
	slot: ItemSlot;
	bossNpcId: number;
	bossName: string;
	key: string;
}

interface DroptimizerResult {
	candidate: DroptimizerCandidate;
	dpsAvg: number;
	dpsStdev: number;
	iterationsRun: number;
	delta: number;
	percentDelta: number;
	// 'active'    = still being simmed (or final pass produced no clear verdict)
	// 'confirmed' = early-stopped: p < 0.05 that this is better than equipped
	// 'culled'    = early-stopped: p < 0.05 that this is NOT better than equipped
	status: 'active' | 'confirmed' | 'culled';
	decidedAtPass: number | null;
}

export class DroptimizerTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	private settingsContainer!: HTMLElement;
	private resultsContainer!: HTMLElement;
	private candidatesElem!: HTMLElement;
	private runButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private smartSimCheckbox!: HTMLInputElement;
	private phaseButtons: Map<Phase, HTMLButtonElement> = new Map();

	private progressBanner!: HTMLElement;
	private progressTitle!: HTMLElement;
	private progressBar!: HTMLElement;
	private progressMessage!: HTMLElement;
	private progressTimer: number | null = null;
	private elapsedSpan!: HTMLElement;

	private selectedPhase: Phase = 2;
	private useSmartSim = true;
	private useEpPrefilter = true;
	private viewMode: 'boss' | 'slot' = 'boss';
	private candidates: DroptimizerCandidate[] = [];

	// Fallback gems for candidate items. Empty sockets matching one of these
	// colors get filled with the corresponding fallback gem at sim time.
	// Indices match FALLBACK_GEM_COLORS below.
	private fallbackGems: (UIGem | null)[] = [null, null, null, null, null];
	private gemIconElements: HTMLImageElement[] = [];

	// Cached last results so the user can flip view mode without resimming.
	private lastResults: {
		resultsByKey: Map<string, DroptimizerResult>;
		baselineDps: number;
		baselineStdev: number;
		baselineSem: number;
		currentPassIdx: number;
		totalPasses: number;
	} | null = null;

	private isRunning = false;
	private isCancelling = false;
	private simStart = 0;
	private abortController: AbortController | null = null;

	constructor(parentElem: HTMLElement, simUI: IndividualSimUI<any>) {
		super(parentElem, simUI, { identifier: 'droptimizer-tab', title: 'Droptimizer' });
		this.simUI = simUI;

		this.buildTabContent();

		this.simUI.sim.waitForInit().then(() => {
			this.refreshCandidates();
			this.simUI.player.gearChangeEmitter.on(() => this.refreshCandidates());
		});
	}

	protected buildTabContent(): void {
		const settingsRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();
		const candidatesRef = ref<HTMLDivElement>();
		const runButtonRef = ref<HTMLButtonElement>();
		const cancelButtonRef = ref<HTMLButtonElement>();
		const smartSimRef = ref<HTMLInputElement>();
		const bannerRef = ref<HTMLDivElement>();
		const bannerTitleRef = ref<HTMLDivElement>();
		const bannerBarRef = ref<HTMLDivElement>();
		const bannerMessageRef = ref<HTMLDivElement>();
		const elapsedRef = ref<HTMLSpanElement>();
		const epPrefilterRef = ref<HTMLInputElement>();

		this.contentContainer.appendChild(
			<div className="droptimizer-tab-content">
				<div className="droptimizer-tab-settings" ref={settingsRef}>
					<div className="droptimizer-header">
						<h4>Droptimizer</h4>
						<p className="text-muted small mb-3">
							Sims each potential drop swapped into your current gear, one piece at a time, and ranks them by DPS gain.
							Surrounding gear is held constant — see the Bulk tab if you want to explore multi-slot combinations.
						</p>
					</div>

					<div className="droptimizer-phase mb-3">
						<label className="form-label d-block">Phase</label>
						<div className="btn-group btn-group-sm" attributes={{ role: 'group', 'aria-label': 'Phase' }}>
							{PHASES.map(p => this.buildPhaseButton(p))}
						</div>
						<div className="text-muted small mt-1" ref={ref<HTMLDivElement>()} id="droptimizer-phase-desc">
							{PHASE_LABELS[this.selectedPhase]} — only items tagged with this phase
						</div>
					</div>

					<div className="form-check mb-3">
						<input
							ref={epPrefilterRef}
							className="form-check-input"
							type="checkbox"
							id="droptimizer-ep-prefilter"
							checked={this.useEpPrefilter}
						/>
						<label className="form-check-label" htmlFor="droptimizer-ep-prefilter">
							Pre-filter by stat weights (EP)
						</label>
						<div className="text-muted small">
							Drops items whose EP is more than {(EP_PREFILTER_TOLERANCE * 100).toFixed(0)}% below the currently-equipped item.
							Skipped for trinkets (proc-heavy). Has no effect until you've computed stat weights.
						</div>
					</div>

					<div className="droptimizer-view-mode mb-3">
						<label className="form-label d-block">Group results by</label>
						<div className="btn-group btn-group-sm" attributes={{ role: 'group', 'aria-label': 'View mode' }}>
							{this.buildViewModeButton('boss', 'By Boss')}
							{this.buildViewModeButton('slot', 'By Slot')}
						</div>
					</div>

					<div className="droptimizer-fallback-gems mb-3">
						<label className="form-label d-block">Fill empty sockets with</label>
						<div className="droptimizer-gem-row">
							{FALLBACK_GEM_COLORS.map((color, idx) => this.buildGemPicker(color, idx))}
						</div>
						<div className="text-muted small mt-1">
							Empty sockets on candidate items get filled with the matching gem. Enchants carry over from your current gear when compatible (weapon 2H↔1H swaps will lose theirs).
						</div>
					</div>

					<div className="form-check mb-3">
						<input
							ref={smartSimRef}
							className="form-check-input"
							type="checkbox"
							id="droptimizer-smart-sim"
							checked={this.useSmartSim}
						/>
						<label className="form-check-label" htmlFor="droptimizer-smart-sim">
							Smart Sim (recommended)
						</label>
						<div className="text-muted small">
							Screens candidates at {SMART_SIM_PASS_BUDGETS[0]} iterations, then accumulates more on the survivors. Each pass adds to (not replaces) the prior sample. Stops simming any item once it's statistically significant (p &lt; 0.05) as an upgrade or non-upgrade vs. the equipped item, with at least {MIN_ITERS_FOR_CONFIRMATION.toLocaleString()} iterations required before an upgrade is confirmed.
						</div>
					</div>

					<div className="droptimizer-candidate-count text-muted small mb-3" ref={candidatesRef}>
						0 candidate items
					</div>

					<button ref={runButtonRef} className="btn btn-primary droptimizer-run-btn" type="button">
						<i className="fas fa-flask me-1" /> Run Droptimizer
					</button>
				</div>

				<div ref={bannerRef} className="droptimizer-progress-banner hide" attributes={{ role: 'status' }}>
					<div className="droptimizer-progress-row">
						<div className="droptimizer-progress-text">
							<div ref={bannerTitleRef} className="droptimizer-progress-title">
								Running…
							</div>
							<div className="droptimizer-progress-meta text-muted small">
								<span>Elapsed </span>
								<span ref={elapsedRef}>0s</span>
								<span ref={bannerMessageRef} className="droptimizer-progress-msg ms-2" />
							</div>
						</div>
						<button ref={cancelButtonRef} type="button" className="btn btn-sm btn-outline-cancel droptimizer-progress-cancel">
							<i className="fa fa-ban me-1" />
							Cancel
						</button>
					</div>
					<div className="progress droptimizer-progress-bar-outer">
						<div ref={bannerBarRef} className="progress-bar" attributes={{ role: 'progressbar' }} />
					</div>
				</div>

				<div className="droptimizer-tab-results mt-4" ref={resultsRef} />
			</div>,
		);

		this.settingsContainer = settingsRef.value!;
		this.resultsContainer = resultsRef.value!;
		this.candidatesElem = candidatesRef.value!;
		this.runButton = runButtonRef.value!;
		this.cancelButton = cancelButtonRef.value!;
		this.smartSimCheckbox = smartSimRef.value!;
		this.progressBanner = bannerRef.value!;
		this.progressTitle = bannerTitleRef.value!;
		this.progressBar = bannerBarRef.value!;
		this.progressMessage = bannerMessageRef.value!;
		this.elapsedSpan = elapsedRef.value!;

		this.runButton.addEventListener('click', () => this.runDroptimizer());
		this.cancelButton.addEventListener('click', () => this.abortDroptimizer());
		this.smartSimCheckbox.addEventListener('change', () => {
			this.useSmartSim = this.smartSimCheckbox.checked;
		});
		epPrefilterRef.value!.addEventListener('change', () => {
			this.useEpPrefilter = epPrefilterRef.value!.checked;
			this.refreshCandidates();
		});
		// Re-filter whenever the player's stat weights change so toggling
		// "use existing weights" in the EP modal updates the candidate count live.
		this.simUI.player.epWeightsChangeEmitter.on(() => this.refreshCandidates());
	}

	private buildPhaseButton(phase: Phase): HTMLElement {
		const btnRef = ref<HTMLButtonElement>();
		const isActive = phase === this.selectedPhase;
		const wrapper = (
			<button
				ref={btnRef}
				type="button"
				className={clsx('btn', isActive ? 'btn-primary' : 'btn-outline-secondary')}
				dataset={{ phase: String(phase) }}
				attributes={{ title: PHASE_LABELS[phase] }}>
				P{phase}
			</button>
		) as HTMLButtonElement;
		this.phaseButtons.set(phase, btnRef.value!);
		btnRef.value!.addEventListener('click', () => {
			if (this.selectedPhase === phase) return;
			this.selectedPhase = phase;
			this.phaseButtons.forEach((b, p) => {
				const active = p === phase;
				b.classList.toggle('btn-primary', active);
				b.classList.toggle('btn-outline-secondary', !active);
			});
			const desc = this.settingsContainer.querySelector('#droptimizer-phase-desc');
			if (desc) desc.textContent = `${PHASE_LABELS[phase]} — only items tagged with this phase`;
			this.refreshCandidates();
		});
		return wrapper;
	}

	private buildGemPicker(color: GemColor, idx: number): HTMLElement {
		const containerRef = ref<HTMLDivElement>();
		const gemIconRef = ref<HTMLImageElement>();
		const socketIconRef = ref<HTMLImageElement>();
		const wrapper = (
			<div ref={containerRef} className="droptimizer-gem-socket" attributes={{ title: GemColor[color].replace('GemColor', '') }}>
				<img ref={gemIconRef} className="droptimizer-gem-icon hide" />
				<img ref={socketIconRef} className="droptimizer-socket-icon" src={getEmptyGemSocketIconUrl(color)} />
			</div>
		) as HTMLElement;

		this.gemIconElements[idx] = gemIconRef.value!;

		let selector: GemSelectorModal | null = null;
		const onSelect = (itemData: ItemData<UIGem>) => {
			this.fallbackGems[idx] = itemData.item;
			ActionId.fromItemId(itemData.id)
				.fill()
				.then(filledId => {
					this.gemIconElements[idx].src = filledId.iconUrl;
					this.gemIconElements[idx].classList.remove('hide');
				});
			selector?.close();
		};
		const onRemove = () => {
			this.fallbackGems[idx] = null;
			this.gemIconElements[idx].classList.add('hide');
			this.gemIconElements[idx].src = '';
			selector?.close();
		};
		const open = () => {
			if (!selector) selector = new GemSelectorModal(this.simUI.rootElem, this.simUI, color, onSelect, onRemove);
			selector.show();
		};
		containerRef.value!.addEventListener('click', open);
		gemIconRef.value!.addEventListener('click', open);
		return wrapper;
	}

	private buildViewModeButton(mode: 'boss' | 'slot', label: string): HTMLElement {
		const btnRef = ref<HTMLButtonElement>();
		const wrapper = (
			<button
				ref={btnRef}
				type="button"
				className={clsx('btn', mode === this.viewMode ? 'btn-primary' : 'btn-outline-secondary')}
				dataset={{ viewMode: mode }}>
				{label}
			</button>
		) as HTMLButtonElement;
		btnRef.value!.addEventListener('click', () => {
			if (this.viewMode === mode) return;
			this.viewMode = mode;
			// Update all view-mode buttons' active state.
			const buttons = this.settingsContainer.querySelectorAll<HTMLButtonElement>('button[data-view-mode]');
			buttons.forEach(b => {
				const isActive = b.dataset.viewMode === mode;
				b.classList.toggle('btn-primary', isActive);
				b.classList.toggle('btn-outline-secondary', !isActive);
			});
			this.refreshResults();
		});
		return wrapper;
	}

	private refreshResults(): void {
		if (!this.lastResults) return;
		const { resultsByKey, baselineDps, baselineStdev, baselineSem, currentPassIdx, totalPasses } = this.lastResults;
		this.renderResults(resultsByKey, baselineDps, baselineStdev, baselineSem, currentPassIdx, totalPasses);
	}

	private refreshCandidates(): void {
		if (!this.simUI.sim.db) return;
		const db = this.simUI.sim.db;
		const spec = this.simUI.player.getPlayerSpec();
		const currentGear = this.simUI.player.getGear();

		const candidates: DroptimizerCandidate[] = [];
		const seen = new Set<string>();

		// EP pre-filter setup. If weights haven't been computed (all zero), skip
		// the filter entirely — no useful signal to act on.
		const epWeights = this.simUI.player.getEpWeights();
		const epActive = this.useEpPrefilter && !epWeights.equals(new Stats());

		for (const item of db.getAllItems()) {
			// Single-phase filter — only items tagged with the selected phase.
			if (item.phase !== this.selectedPhase) continue;

			// Boss attribution: prefer a real drop source NPC name when available;
			// otherwise (tier pieces, badge gear, quest rewards) fall back to a
			// generic per-phase label.
			let bossNpcId = 0;
			let bossName: string = PHASE_FALLBACK_BOSS[this.selectedPhase] ?? `Phase ${this.selectedPhase}`;
			for (const src of item.sources) {
				if (src.source.oneofKind === 'drop' && src.source.drop.npcId) {
					bossNpcId = src.source.drop.npcId;
					const npc = db.getNpc(bossNpcId);
					if (npc?.name) bossName = npc.name;
					break;
				}
			}

			const eligibleSlots = getEligibleItemSlots(item);
			for (const slot of eligibleSlots) {
				if (!canEquipItem(item, spec, slot)) continue;

				const equippedAtSlot = currentGear.getEquippedItem(slot);
				if (equippedAtSlot && equippedAtSlot.item.id === item.id) continue;

				// EP pre-filter: drop candidates whose stat-weighted EP is well
				// below the equipped item. Skipped for trinkets (proc-driven, EP
				// doesn't capture procs). Skipped when the slot has no equipped
				// item (anything beats empty).
				if (epActive && equippedAtSlot && slot !== ItemSlot.ItemSlotTrinket1 && slot !== ItemSlot.ItemSlotTrinket2) {
					const equippedEP = this.simUI.player.computeItemEP(equippedAtSlot.item, slot);
					if (equippedEP > 0) {
						const candidateEP = this.simUI.player.computeItemEP(item, slot);
						if (candidateEP < equippedEP * (1 - EP_PREFILTER_TOLERANCE)) continue;
					}
				}

				const key = `${item.id}-${slot}`;
				if (seen.has(key)) continue;
				seen.add(key);

				candidates.push({ item, slot, bossNpcId, bossName, key });
			}
		}

		this.candidates = candidates;
		this.updateCandidateCount();
	}

	private updateCandidateCount(): void {
		const n = this.candidates.length;
		this.candidatesElem.textContent = `${n} candidate item${n === 1 ? '' : 's'} from selected sources`;
		this.runButton.disabled = n === 0 || this.isRunning;
	}

	private async runDroptimizer(): Promise<void> {
		if (this.isRunning) return;
		if (this.candidates.length === 0) return;

		this.isRunning = true;
		this.isCancelling = false;
		this.runButton.disabled = true;
		this.abortController = new AbortController();
		const abortSignal = this.abortController.signal;
		this.resultsContainer.replaceChildren();
		this.showProgressBanner();

		const originalGear = this.simUI.player.getGear();
		const fullIterations = this.simUI.sim.getIterations();
		// Cumulative iteration budgets per pass. Smart Sim adds checkpoints
		// before the full budget so items can early-terminate. Each pass runs
		// (budget − currentIters) more iters and combines results.
		const passBudgets = this.useSmartSim
			? [...SMART_SIM_PASS_BUDGETS.filter(b => b < fullIterations), fullIterations]
			: [fullIterations];

		// Per-candidate result accumulator. Keyed by candidate.key.
		const resultsByKey = new Map<string, DroptimizerResult>();
		for (const c of this.candidates) {
			resultsByKey.set(c.key, {
				candidate: c,
				dpsAvg: 0,
				dpsStdev: 0,
				iterationsRun: 0,
				delta: 0,
				percentDelta: 0,
				status: 'active',
				decidedAtPass: null,
			});
		}

		let baselineDps = 0;
		let baselineStdev = 0;
		let baselineSem = 0;
		let activeCandidates: DroptimizerCandidate[] = [...this.candidates];

		// Total work is baseline + sum across passes of active * 1 round each.
		// We don't know active counts ahead of time for passes 2+, so estimate
		// with a 30% survival rate for progress purposes.
		let estimatedTotalRounds = 1 + this.candidates.length;
		if (this.useSmartSim && passBudgets.length > 1) {
			let estimatedSurvivors = this.candidates.length;
			for (let i = 1; i < passBudgets.length; i++) {
				estimatedSurvivors = Math.max(MIN_UNDECIDED_AFTER_PASS, Math.ceil(estimatedSurvivors * 0.3));
				estimatedTotalRounds += estimatedSurvivors;
			}
		}
		let completedRounds = 0;
		const setProgressForRound = (label: string, intraFraction: number) => {
			this.setSimProgress(label, completedRounds + intraFraction, estimatedTotalRounds);
		};

		try {
			await this.simUI.sim.signalManager.abortType(RequestTypes.All);
			this.simStart = Date.now();

			// Baseline always runs at full iterations for a tight reference SEM.
			const baselineResult = await this.runSingleSim(
				originalGear,
				fullIterations,
				abortSignal,
				progress => setProgressForRound('Simming baseline gear', progress),
			);
			if (!baselineResult) return;
			baselineDps = baselineResult.raidMetrics!.dps!.avg;
			baselineStdev = baselineResult.raidMetrics!.dps!.stdev;
			baselineSem = baselineStdev / Math.sqrt(fullIterations);
			completedRounds++;

			for (let passIdx = 0; passIdx < passBudgets.length; passIdx++) {
				const cumulativeBudget = passBudgets[passIdx];
				const passLabel = this.useSmartSim
					? passIdx === passBudgets.length - 1
						? `Final pass (up to ${cumulativeBudget.toLocaleString()} iters)`
						: `Pass ${passIdx + 1} of ${passBudgets.length} (to ${cumulativeBudget.toLocaleString()} iters)`
					: `Simming candidates (${cumulativeBudget.toLocaleString()} iters)`;

				for (let i = 0; i < activeCandidates.length; i++) {
					this.throwIfAborted(abortSignal);
					const candidate = activeCandidates[i];
					const existing = resultsByKey.get(candidate.key)!;

					// Run only the incremental iterations needed to reach the
					// cumulative budget for this pass.
					const itersThisBatch = cumulativeBudget - existing.iterationsRun;
					if (itersThisBatch <= 0) {
						completedRounds++;
						continue;
					}

					const swappedGear = this.gearWithCandidate(originalGear, candidate);
					const label = `${passLabel} — candidate ${i + 1}/${activeCandidates.length}`;
					const sim = await this.runSingleSim(swappedGear, itersThisBatch, abortSignal, progress =>
						setProgressForRound(label, progress),
					);
					if (!sim) return;

					// Accumulate the new batch into the running sample using
					// Welford's online combiner — no work thrown away.
					const combined = combineSamples(
						{ n: existing.iterationsRun, mean: existing.dpsAvg, stdev: existing.dpsStdev },
						{ n: itersThisBatch, mean: sim.raidMetrics!.dps!.avg, stdev: sim.raidMetrics!.dps!.stdev },
					);
					existing.iterationsRun = combined.n;
					existing.dpsAvg = combined.mean;
					existing.dpsStdev = combined.stdev;
					existing.delta = combined.mean - baselineDps;
					existing.percentDelta = baselineDps > 0 ? (existing.delta / baselineDps) * 100 : 0;

					completedRounds++;
					this.renderResults(resultsByKey, baselineDps, baselineStdev, baselineSem, passIdx, passBudgets.length);
				}

				// Classify between passes — both directions (not after the final one).
				if (passIdx < passBudgets.length - 1) {
					activeCandidates = this.classifyCandidates(
						activeCandidates,
						resultsByKey,
						baselineSem,
						passIdx,
					);
					// Re-estimate remaining rounds based on real undecided count.
					let remaining = activeCandidates.length;
					estimatedTotalRounds = completedRounds + remaining;
					let estSurv = remaining;
					for (let nextPass = passIdx + 2; nextPass < passBudgets.length; nextPass++) {
						estSurv = Math.max(MIN_UNDECIDED_AFTER_PASS, Math.ceil(estSurv * 0.4));
						estimatedTotalRounds += estSurv;
					}
					this.renderResults(resultsByKey, baselineDps, baselineStdev, baselineSem, passIdx, passBudgets.length);
				}
			}
		} catch (error) {
			if (!this.isCancelling) {
				console.error(error);
				new Toast({
					variant: 'error',
					body: typeof error === 'string' ? error : (error as Error)?.message || 'Droptimizer failed',
				});
			}
		} finally {
			await this.simUI.player.setGearAsync(TypedEvent.nextEventID(), originalGear);
			this.isRunning = false;
			this.isCancelling = false;
			this.runButton.disabled = false;
			this.hideProgressBanner();
			this.renderResults(resultsByKey, baselineDps, baselineStdev, baselineSem, passBudgets.length - 1, passBudgets.length);
		}
	}

	private showProgressBanner(): void {
		this.progressBanner.classList.remove('hide');
		this.elapsedSpan.textContent = '0s';
		this.progressBar.style.width = '0%';
		this.progressBar.setAttribute('aria-valuenow', '0');
		this.progressMessage.textContent = '';
		this.progressTitle.textContent = 'Starting…';
		if (this.progressTimer !== null) clearInterval(this.progressTimer);
		this.progressTimer = window.setInterval(() => this.updateElapsed(), 100);
	}

	private hideProgressBanner(): void {
		this.progressBanner.classList.add('hide');
		if (this.progressTimer !== null) {
			clearInterval(this.progressTimer);
			this.progressTimer = null;
		}
	}

	private updateElapsed(): void {
		if (!this.simStart) return;
		const elapsed = (Date.now() - this.simStart) / 1000;
		this.elapsedSpan.textContent = elapsed < 60
			? `${elapsed.toFixed(1)}s`
			: `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
	}

	// Returns the set of still-uncertain candidates and marks the rest as
	// either 'confirmed' (statistically-significant upgrade) or 'culled'
	// (statistically-significant not-upgrade) in the results map.
	private classifyCandidates(
		active: DroptimizerCandidate[],
		resultsByKey: Map<string, DroptimizerResult>,
		baselineSem: number,
		passIdx: number,
	): DroptimizerCandidate[] {
		// Per-item one-sided test of H1: μ_candidate > μ_baseline.
		//   z = delta / combinedSEM
		//   verdict: 'confirmed' if z >  DECISIVE_Z_SCORE (p < 0.05 it's better)
		//            'culled'    if z < -DECISIVE_Z_SCORE (p < 0.05 it's worse)
		//            'uncertain' otherwise
		// Confirmation is additionally gated on a minimum iteration count so the
		// displayed ΔDPS for confirmed items has a tight enough SE to be trusted.
		const verdict = (r: DroptimizerResult): 'confirmed' | 'culled' | 'uncertain' => {
			if (r.iterationsRun === 0) return 'uncertain';
			const candidateSem = r.dpsStdev / Math.sqrt(r.iterationsRun);
			const combinedSem = Math.sqrt(candidateSem * candidateSem + baselineSem * baselineSem);
			if (combinedSem === 0) return 'uncertain';
			const z = r.delta / combinedSem;
			if (z > DECISIVE_Z_SCORE) {
				if (r.iterationsRun < MIN_ITERS_FOR_CONFIRMATION) return 'uncertain';
				return 'confirmed';
			}
			if (z < -DECISIVE_Z_SCORE) return 'culled';
			return 'uncertain';
		};

		const verdicts = new Map<string, 'confirmed' | 'culled' | 'uncertain'>();
		for (const c of active) verdicts.set(c.key, verdict(resultsByKey.get(c.key)!));

		const uncertainRaw = active.filter(c => verdicts.get(c.key) === 'uncertain');

		// Floor: if statistical classification would resolve everyone, keep the
		// top-K most ambiguous (smallest |z|) so RNG-driven false classifications
		// at low iteration counts get another pass to either confirm or refute.
		let uncertain = uncertainRaw;
		if (uncertain.length < MIN_UNDECIDED_AFTER_PASS && active.length >= MIN_UNDECIDED_AFTER_PASS) {
			const ranked = [...active].sort((a, b) => {
				const ra = resultsByKey.get(a.key)!;
				const rb = resultsByKey.get(b.key)!;
				const za = ra.iterationsRun > 0 ? Math.abs(ra.delta) / Math.max(1e-9, Math.sqrt((ra.dpsStdev * ra.dpsStdev) / ra.iterationsRun + baselineSem * baselineSem)) : 0;
				const zb = rb.iterationsRun > 0 ? Math.abs(rb.delta) / Math.max(1e-9, Math.sqrt((rb.dpsStdev * rb.dpsStdev) / rb.iterationsRun + baselineSem * baselineSem)) : 0;
				return za - zb;
			});
			uncertain = ranked.slice(0, MIN_UNDECIDED_AFTER_PASS);
		}

		const uncertainKeys = new Set(uncertain.map(c => c.key));
		for (const c of active) {
			if (uncertainKeys.has(c.key)) continue;
			const r = resultsByKey.get(c.key)!;
			const v = verdicts.get(c.key)!;
			// v is 'uncertain' only if forced out by the floor; treat as still active.
			if (v === 'uncertain') continue;
			r.status = v;
			r.decidedAtPass = passIdx + 1;
		}
		return uncertain;
	}

	private gearWithCandidate(baseGear: Gear, candidate: DroptimizerCandidate): Gear {
		const equippedAtSlot = baseGear.getEquippedItem(candidate.slot);
		// withItem migrates the previously-equipped item's enchant (when compatible)
		// and gems (re-slotted into matching colors where possible). Extra sockets
		// on the candidate end up empty — we fill those below with the fallback gems.
		let swapped = equippedAtSlot ? equippedAtSlot.withItem(candidate.item) : new EquippedItem({ item: candidate.item });

		const socketColors = swapped.gemSockets;
		const currentGems = swapped._gems;
		for (let i = 0; i < socketColors.length; i++) {
			if (currentGems[i] != null) continue; // already filled by withItem
			const colorIdx = FALLBACK_GEM_COLORS.indexOf(socketColors[i]);
			const fallback = colorIdx >= 0 ? this.fallbackGems[colorIdx] : null;
			if (fallback) {
				swapped = swapped.withGem(fallback, i);
			}
		}

		return baseGear.withEquippedItem(candidate.slot, swapped);
	}

	private async runSingleSim(
		gear: Gear,
		iterations: number,
		abortSignal: AbortSignal,
		onIntraProgress: (fraction: number) => void,
	): Promise<RaidSimResult | null> {
		const response = await Promise.race([
			this.simUI.runSimLightweight(
				gear,
				(progressMetrics: ProgressMetrics) => {
					const frac = progressMetrics.totalIterations > 0
						? progressMetrics.completedIterations / progressMetrics.totalIterations
						: 0;
					onIntraProgress(frac);
				},
				{ iterations },
			),
			this.makeAbortPromise(abortSignal),
		]);
		if (this.isCancelling) return null;
		if (!response || (response && 'type' in response)) {
			throw new Error(response && 'message' in response ? response.message : 'Sim failed');
		}
		const [, result] = response;
		return result;
	}

	private makeAbortPromise(signal: AbortSignal): Promise<never> {
		return new Promise((_, reject) => {
			if (signal.aborted) {
				reject(new Error('Droptimizer cancelled'));
				return;
			}
			signal.addEventListener('abort', () => reject(new Error('Droptimizer cancelled')), { once: true });
		});
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new Error('Droptimizer cancelled');
	}

	private setSimProgress(label: string, current: number, total: number): void {
		const elapsedSeconds = (Date.now() - this.simStart) / 1000;
		const remainingRounds = Math.max(0, total - current);
		const secondsRemaining = current > 0 ? (elapsedSeconds / current) * remainingRounds : 0;

		this.progressTitle.textContent = label;
		const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
		this.progressBar.style.width = `${pct}%`;
		this.progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
		this.progressMessage.textContent = isNaN(secondsRemaining)
			? `· ${Math.ceil(current)}/${total}`
			: `· ${Math.ceil(current)}/${total} · ~${Math.round(secondsRemaining)}s remaining`;
	}

	private async abortDroptimizer(): Promise<void> {
		if (this.isCancelling) return;
		this.isCancelling = true;
		try {
			await this.simUI.sim.signalManager.abortType(RequestTypes.All);
			if (this.abortController && !this.abortController.signal.aborted) {
				this.abortController.abort();
			}
		} catch (e) {
			console.error('Failed to abort droptimizer', e);
		}
	}

	private renderResults(
		resultsByKey: Map<string, DroptimizerResult>,
		baselineDps: number,
		baselineStdev: number,
		baselineSem: number,
		currentPassIdx: number,
		totalPasses: number,
	): void {
		// Cache so the user can flip view mode without resimming.
		this.lastResults = { resultsByKey, baselineDps, baselineStdev, baselineSem, currentPassIdx, totalPasses };

		const allResults = Array.from(resultsByKey.values()).filter(r => r.iterationsRun > 0);
		// "Shown" = anything not culled. Confirmed upgrades + still-uncertain
		// items are both displayed in the main table, sorted by delta.
		const shown = allResults.filter(r => r.status !== 'culled').sort((a, b) => b.delta - a.delta);
		const confirmedCount = shown.filter(r => r.status === 'confirmed').length;
		const activeCount = shown.length - confirmedCount;
		const culled = allResults.filter(r => r.status === 'culled').sort((a, b) => b.delta - a.delta);

		const grouped = new Map<string, DroptimizerResult[]>();
		const groupOrder: string[] = [];
		const groupKey = (r: DroptimizerResult) =>
			this.viewMode === 'boss' ? r.candidate.bossName : ITEM_SLOT_NAMES[r.candidate.slot] ?? ItemSlot[r.candidate.slot];

		for (const result of shown) {
			const key = groupKey(result);
			if (!grouped.has(key)) {
				grouped.set(key, []);
				groupOrder.push(key);
			}
			grouped.get(key)!.push(result);
		}
		// Order groups by their best ΔDPS descending.
		const orderedGroups = Array.from(grouped.entries()).sort((a, b) => {
			const aTopDelta = Math.max(...a[1].map(r => r.delta));
			const bTopDelta = Math.max(...b[1].map(r => r.delta));
			return bTopDelta - aTopDelta;
		});

		const passLabel = totalPasses > 1
			? `Pass ${Math.min(currentPassIdx + 1, totalPasses)} of ${totalPasses}`
			: 'Single pass';

		this.resultsContainer.replaceChildren(
			<div className="droptimizer-results-content">
				<div className="droptimizer-baseline mb-3">
					<strong>Baseline DPS:</strong> {fmtDps(baselineDps)} <span className="text-muted small">(±{fmtDps(baselineStdev)})</span>
					{' · '}
					<span className="text-muted small">
						{passLabel} · {confirmedCount} confirmed, {activeCount} uncertain, {culled.length} culled
					</span>
				</div>
				{orderedGroups.map(([groupName, groupResults]) => (
					<div className="droptimizer-group mb-4">
						<h5 className="droptimizer-group-name">{groupName}</h5>
						<table className="table table-sm table-hover droptimizer-results-table">
							<thead>
								<tr>
									<th>Item</th>
									<th>{this.viewMode === 'boss' ? 'Slot' : 'Boss'}</th>
									<th className="text-end">DPS</th>
									<th className="text-end">Δ DPS</th>
									<th className="text-end">% Change</th>
									<th className="text-end">Iters</th>
								</tr>
							</thead>
							<tbody>
								{groupResults.map(result => (
									<tr className={clsx(result.status === 'confirmed' && 'droptimizer-row-confirmed')}>
										<td>
											{result.status === 'confirmed' && (
												<span
													className="droptimizer-confirmed-badge text-success me-1"
													attributes={{ title: `Confirmed upgrade (p < 0.05) at pass ${result.decidedAtPass}` }}>
													✓
												</span>
											)}
											{renderItemLink(result.candidate.item)}
										</td>
										<td className="text-muted small">
											{this.viewMode === 'boss'
												? ITEM_SLOT_NAMES[result.candidate.slot] ?? ItemSlot[result.candidate.slot]
												: result.candidate.bossName}
										</td>
										<td className="text-end">{fmtDps(result.dpsAvg)}</td>
										<td className={clsx('text-end', deltaClass(result.delta))}>{fmtDelta(result.delta)}</td>
										<td className={clsx('text-end', deltaClass(result.delta))}>{fmtPct(result.percentDelta)}</td>
										<td className="text-end text-muted small">{result.iterationsRun.toLocaleString()}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))}
				{culled.length > 0 && this.renderCulledSection(culled, baselineSem)}
			</div>,
		);
	}

	private renderCulledSection(culled: DroptimizerResult[], _baselineSem: number): HTMLElement {
		return (
			<details className="droptimizer-culled-section mt-4">
				<summary className="text-muted">Ruled out by Smart Sim ({culled.length} items)</summary>
				<table className="table table-sm table-hover droptimizer-culled-table mt-2">
					<thead>
						<tr>
							<th>Item</th>
							<th>Slot</th>
							<th>Boss</th>
							<th className="text-end">Δ DPS</th>
							<th className="text-end">% Change</th>
							<th className="text-end">Culled at</th>
						</tr>
					</thead>
					<tbody>
						{culled.map(result => (
							<tr className="text-muted">
								<td>{renderItemLink(result.candidate.item)}</td>
								<td className="small">{ITEM_SLOT_NAMES[result.candidate.slot] ?? ItemSlot[result.candidate.slot]}</td>
								<td className="small">{result.candidate.bossName}</td>
								<td className="text-end text-danger">{fmtDelta(result.delta)}</td>
								<td className="text-end text-danger">{fmtPct(result.percentDelta)}</td>
								<td className="text-end small">Pass {result.decidedAtPass ?? '?'} ({result.iterationsRun.toLocaleString()} iters)</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		) as HTMLElement;
	}
}
