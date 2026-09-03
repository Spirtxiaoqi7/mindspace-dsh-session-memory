import { TYPERT } from "./typert.js";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/memory/fold.ts
const DEFAULT_COMPACTION_POLICY = Object.freeze({
	enabled: true,
	thresholdRatio: .164,
	retainTokens: 64e3,
	maxTokens: 6e3,
	updatedAt: 0
});
function normalizeCompactionPolicy(value) {
	const candidate = value !== null && typeof value === "object" ? value : {};
	return {
		enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_COMPACTION_POLICY.enabled,
		thresholdRatio: Number.isFinite(candidate.thresholdRatio) && candidate.thresholdRatio >= .05 && candidate.thresholdRatio <= .8 ? candidate.thresholdRatio : DEFAULT_COMPACTION_POLICY.thresholdRatio,
		retainTokens: Number.isInteger(candidate.retainTokens) && candidate.retainTokens >= 4096 ? candidate.retainTokens : DEFAULT_COMPACTION_POLICY.retainTokens,
		maxTokens: Number.isInteger(candidate.maxTokens) && candidate.maxTokens >= 512 && candidate.maxTokens <= 8192 ? candidate.maxTokens : DEFAULT_COMPACTION_POLICY.maxTokens,
		updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0
	};
}
function emptyModeMemory() {
	return {
		people: [],
		assistantSetting: "",
		assistantState: "",
		assistantRequirements: [],
		memories: []
	};
}
function emptySessionMemory() {
	return {
		version: 5,
		revision: 0,
		activeMode: "chat",
		modeSource: "migration",
		modeReason: "Initial mode",
		chat: emptyModeMemory(),
		work: emptyModeMemory(),
		bridge: {
			transitionNote: "",
			pendingWrites: []
		},
		updatedAt: 0
	};
}
function mergeText(current, incoming) {
	const left = current.trim();
	const right = incoming.trim();
	if (!left) return right;
	if (!right || left.includes(right)) return left;
	if (right.includes(left)) return right;
	return `${left}；${right}`;
}
function normalizeMemoryCards(items, fallbackCategory, limit = 3) {
	const result = [];
	const categories = /* @__PURE__ */ new Map();
	for (const [index, item] of items.entries()) {
		const category = item.category.trim() || fallbackCategory;
		const text = item.text.trim();
		if (!text) continue;
		const key = category.toLocaleLowerCase();
		const duplicate = categories.get(key);
		if (duplicate !== void 0) {
			const current = result[duplicate];
			result[duplicate] = {
				...current,
				text: mergeText(current.text, text),
				source: current.source === "user" || item.source === "user" ? "user" : "extracted",
				evidenceSeqs: [.../* @__PURE__ */ new Set([...current.evidenceSeqs, ...item.evidenceSeqs])]
			};
			continue;
		}
		categories.set(key, result.length);
		result.push({
			...item,
			id: item.id.trim() || `replayed-${fallbackCategory}-${index}`,
			category,
			text,
			evidenceSeqs: [...new Set(item.evidenceSeqs)]
		});
	}
	while (result.length > limit) {
		const overflow = result.pop();
		const target = result[result.length - 1];
		result[result.length - 1] = {
			...target,
			category: `${target.category} / ${overflow.category}`,
			text: mergeText(target.text, `${overflow.category}：${overflow.text}`),
			evidenceSeqs: [.../* @__PURE__ */ new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])]
		};
	}
	return result;
}
function normalizePeople(people) {
	const result = [];
	const ids = /* @__PURE__ */ new Set();
	for (const [index, person] of people.entries()) {
		const id = person.id.trim() || `person-${index + 1}`;
		if (ids.has(id)) continue;
		ids.add(id);
		result.push({
			...person,
			id,
			name: person.name.trim() || `人物${index + 1}`,
			information: person.information.trim(),
			preference: person.preference.trim(),
			relationship: person.relationship.trim(),
			evidenceSeqs: [...new Set(person.evidenceSeqs)],
			updatedAt: Number.isFinite(person.updatedAt) ? person.updatedAt : 0
		});
		if (result.length === 5) break;
	}
	return result;
}
function normalizeModeMemory(value) {
	return {
		people: normalizePeople(value.people),
		assistantSetting: value.assistantSetting.trim(),
		assistantState: value.assistantState.trim(),
		assistantRequirements: normalizeMemoryCards(value.assistantRequirements, "对AI的要求"),
		memories: normalizeMemoryCards(value.memories, "记忆")
	};
}
function normalizeSessionMemoryDocument(document) {
	return {
		...document,
		version: 5,
		modeReason: document.modeReason.trim(),
		chat: normalizeModeMemory(document.chat),
		work: normalizeModeMemory(document.work),
		bridge: {
			transitionNote: [...document.bridge.transitionNote.trim()].slice(0, 300).join(""),
			pendingWrites: document.bridge.pendingWrites.map((item) => ({
				...item,
				instruction: item.instruction.trim(),
				sourceSeqs: [...new Set(item.sourceSeqs)]
			})).filter((item) => item.instruction)
		}
	};
}
function migrateV4Document(document) {
	return normalizeSessionMemoryDocument({
		version: 5,
		revision: document.revision,
		activeMode: "chat",
		modeSource: "migration",
		modeReason: "Existing memory migrated to Chat",
		chat: {
			people: document.people,
			assistantSetting: "",
			assistantState: "",
			assistantRequirements: document.assistantRequirements,
			memories: document.memories
		},
		work: emptyModeMemory(),
		bridge: {
			transitionNote: "Existing session memory was preserved in Chat.",
			pendingWrites: []
		},
		updatedAt: document.updatedAt
	});
}
function legacyCard(item, category) {
	return {
		...item,
		category,
		evidenceSeqs: [...item.evidenceSeqs]
	};
}
function legacyCards(items, fallback) {
	return normalizeMemoryCards(items.map((item) => ({
		...item,
		evidenceSeqs: [...item.evidenceSeqs]
	})), fallback);
}
function preferenceText(items) {
	return items.map((item) => `${item.category.trim() || "偏好"}：${item.text.trim()}`).filter((value) => !value.endsWith("：")).join("；");
}
function relationshipText(relationship) {
	return relationship === null ? "" : [relationship.status.trim() ? `状态：${relationship.status.trim()}` : "", relationship.context.trim() ? `背景：${relationship.context.trim()}` : ""].filter(Boolean).join("；");
}
function migrateV3Document(document) {
	const information = [document.userProfile.confirmed.trim(), document.userProfile.pendingConfirmation.trim()].filter(Boolean).join("；");
	const preference = preferenceText(document.preferences);
	const relationship = relationshipText(document.relationship);
	const evidenceSeqs = [.../* @__PURE__ */ new Set([
		...document.userProfile.confirmedEvidenceSeqs,
		...document.userProfile.pendingEvidenceSeqs,
		...document.preferences.flatMap((item) => item.evidenceSeqs)
	])];
	const people = [
		information,
		preference,
		relationship
	].some(Boolean) ? [{
		id: "migrated-person-1",
		name: "人物一",
		information,
		preference,
		relationship,
		source: document.preferences.some((item) => item.source === "extracted") ? "extracted" : "user",
		evidenceSeqs,
		updatedAt: -1
	}] : [];
	const memories = document.roleplayPreset?.text.trim() ? [{
		id: "memory-migrated-roleplay",
		category: "既有记忆",
		text: document.roleplayPreset.text.trim(),
		source: "user",
		evidenceSeqs: []
	}] : [];
	return migrateV4Document({
		version: 4,
		revision: document.revision,
		people,
		assistantRequirements: legacyCards(document.assistantRequirements, "对AI的要求"),
		memories,
		updatedAt: document.updatedAt
	});
}
function v2Relationship(document) {
	if (document.relationship === null) return null;
	return {
		status: document.relationship.role.trim(),
		context: [document.relationship.guidance.trim(), document.relationship.mission.trim() ? `历史背景：${document.relationship.mission.trim()}` : ""].filter(Boolean).join("；"),
		updatedAt: document.updatedAt
	};
}
function migrateV2Document(document) {
	return migrateV3Document({
		version: 3,
		revision: document.revision,
		userProfile: {
			confirmed: document.userProfile.confirmed,
			pendingConfirmation: document.userProfile.inferred,
			confirmedEvidenceSeqs: [...document.userProfile.evidenceSeqs],
			pendingEvidenceSeqs: [...document.userProfile.evidenceSeqs]
		},
		preferences: document.preferences,
		assistantRequirements: document.assistantInstructions,
		relationship: v2Relationship(document),
		roleplayPreset: document.roleplayPreset,
		updatedAt: document.updatedAt
	});
}
function migrateLegacyDocument(document) {
	const facts = document.userFacts.map((item) => item.text.trim()).filter(Boolean).join("；");
	return migrateV2Document({
		version: 2,
		revision: document.revision,
		userProfile: {
			confirmed: facts,
			inferred: "",
			evidenceSeqs: [...new Set(document.userFacts.flatMap((item) => item.evidenceSeqs))]
		},
		preferences: document.preferences.map((item) => legacyCard(item, "综合偏好")),
		assistantInstructions: document.assistantInstructions.map((item) => legacyCard(item, "对AI的要求")),
		relationship: document.relationship,
		roleplayPreset: document.roleplayPreset ?? null,
		updatedAt: document.updatedAt
	});
}
function migrateActivity$1(activity) {
	if (activity === null || typeof activity !== "object") return void 0;
	const row = activity;
	const oldSection = String(row["section"] ?? "");
	const section = oldSection === "assistantRequirements" || oldSection === "assistantInstructions" ? "assistantRequirements" : oldSection === "roleplayPreset" ? "memories" : "people";
	return {
		...row,
		section,
		mode: row["mode"] === "chat" || row["mode"] === "work" ? row["mode"] : "chat"
	};
}
function emptySessionMemoryFoldState() {
	return {
		document: emptySessionMemory(),
		memoryActivity: [],
		compactionPolicy: DEFAULT_COMPACTION_POLICY
	};
}
function applySessionMemoryEvent(state, event) {
	if (event.type === "mindspace-compaction/policy") {
		const value = event.data;
		if (value !== null && typeof value === "object") return {
			...state,
			compactionPolicy: normalizeCompactionPolicy(value)
		};
	}
	if (event.type !== "session-memory/change") return state;
	const version = event.data.version;
	const document = version === 1 ? migrateLegacyDocument(event.data.document) : version === 2 ? migrateV2Document(event.data.document) : version === 3 ? migrateV3Document(event.data.document) : version === 4 ? migrateV4Document(event.data.document) : normalizeSessionMemoryDocument(event.data.document);
	const changes = "changes" in event.data ? event.data.changes.map(migrateActivity$1).filter((item) => item !== void 0) : [];
	return {
		...state,
		document,
		memoryActivity: [...state.memoryActivity, ...changes]
	};
}
function sessionMemoryView(state) {
	return {
		document: state.document,
		memoryActivity: state.memoryActivity
	};
}
function foldCompactionPolicy(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return normalizeCompactionPolicy(state.compactionPolicy);
}
function foldSessionMemory(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return sessionMemoryView(state);
}
//#endregion
//#region src/memory/compaction-bridge.ts
/** Public structural boundary; DSH 0.1.x's BasicCompactionEngine satisfies this shape. */
function isMutableProvider(value) {
	if (value === null || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.compactIfNeeded === "function" && typeof candidate.compactNow === "function" && candidate.config !== null && typeof candidate.config === "object";
}
function routedTarget(agent) {
	const route = agent.session.requestHeader()?.config;
	if (route !== void 0 && route.provider.length > 0 && route.model.length > 0) return {
		provider: route.provider,
		model: route.model
	};
	if (agent.options.provider === void 0 || agent.options.model === void 0) return void 0;
	if (agent.options.provider.length === 0 || agent.options.model.length === 0) return void 0;
	return {
		provider: agent.options.provider,
		model: agent.options.model
	};
}
const automaticCommandIds = /* @__PURE__ */ new WeakMap();
/** Read the effective stock-engine pressure state without changing the session. */
async function readSessionCompactionStatus(agent, policy, commandFallbackAvailable = false) {
	const provider = agent.ctx.get("compaction");
	const target = routedTarget(agent);
	const estimatedTokens = agent.ctx.get("tokenMeter")?.measure(agent.session).totalTokens ?? 0;
	let contextWindow = null;
	if (target !== void 0) {
		const llm = agent.ctx.get("llm");
		try {
			contextWindow = (await llm?.resolveModelInfo(target.provider, target.model))?.context?.contextWindow ?? null;
		} catch {
			contextWindow = null;
		}
	}
	const thresholdTokens = contextWindow === null ? null : Math.floor(contextWindow * policy.thresholdRatio);
	const safeRetainRatio = Math.min(.16, policy.thresholdRatio / 2);
	const effectiveRetainTokens = contextWindow === null ? null : Math.min(policy.retainTokens, Math.floor(contextWindow * safeRetainRatio));
	const utilizationRatio = contextWindow === null ? null : estimatedTokens / contextWindow;
	const start = agent.session.events.filter((event) => event.type === "compaction/start").at(-1);
	let lastCompaction = null;
	if (start !== void 0) {
		const end = agent.session.events.findLast((event) => event.type === "compaction/end" && event.data.compactionId === start.data.compactionId);
		lastCompaction = {
			kind: start.data.sourceCommandId === void 0 || automaticCommandIds.get(agent.session)?.has(start.data.sourceCommandId) === true ? "automatic" : "manual",
			status: end === void 0 ? "running" : end.data.error === void 0 ? "completed" : "failed",
			at: end?.time ?? start.time,
			error: end?.data.error ?? ""
		};
	}
	const providerAvailable = isMutableProvider(provider) || commandFallbackAvailable;
	const state = !policy.enabled ? "disabled" : !providerAvailable || thresholdTokens === null ? "unavailable" : estimatedTokens >= thresholdTokens ? "due" : "waiting";
	return {
		providerAvailable,
		provider: target?.provider ?? "",
		model: target?.model ?? "",
		contextWindow,
		estimatedTokens,
		thresholdTokens,
		effectiveRetainTokens,
		utilizationRatio,
		state,
		lastCompaction
	};
}
/**
* Enforce the saved session threshold after a completed turn when the standing
* preset keeps its provider private. The stock `/compact` command remains the
* sole surface mutator and summarizer; this layer only decides when to invoke it.
*/
function installAutomaticCompactionFallback(ctx, policyFor) {
	const commands = ctx.get("commands");
	if (commands === void 0) return () => void 0;
	const checkedTurnEnd = /* @__PURE__ */ new WeakMap();
	const running = /* @__PURE__ */ new WeakSet();
	const check = (agent, force = false) => {
		if (running.has(agent)) return;
		const turnEnd = agent.session.events.findLast((event) => event.type === "turn/end");
		if (!force && (turnEnd === void 0 || checkedTurnEnd.get(agent) === turnEnd.seq)) return;
		if (turnEnd !== void 0) checkedTurnEnd.set(agent, turnEnd.seq);
		running.add(agent);
		(async () => {
			try {
				if ((await readSessionCompactionStatus(agent, policyFor(agent), true)).state !== "due") return;
				const execution = await commands.execute(agent, "/compact", [], new AbortController().signal);
				if (execution !== void 0) {
					let ids = automaticCommandIds.get(agent.session);
					if (ids === void 0) {
						ids = /* @__PURE__ */ new Set();
						automaticCommandIds.set(agent.session, ids);
					}
					ids.add(execution.commandId);
				}
			} finally {
				running.delete(agent);
			}
		})();
	};
	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "idle") check(agent);
	});
	return (agent) => check(agent, true);
}
/** Build an isolated stock-provider config with this session's explicit values. */
function withSessionCompactionPolicy(config, target, policy, contextWindow) {
	const modelPolicies = Array.isArray(config.modelPolicies) ? config.modelPolicies : [];
	const safeRetainRatio = Math.min(.16, policy.thresholdRatio / 2);
	const retention = contextWindow !== void 0 && Number.isInteger(contextWindow) && contextWindow > 0 ? {
		retainTokens: Math.min(policy.retainTokens, Math.floor(contextWindow * safeRetainRatio)),
		retainRatio: void 0
	} : {
		retainTokens: void 0,
		retainRatio: safeRetainRatio
	};
	const base = {
		...config,
		thresholdRatio: policy.thresholdRatio,
		...retention,
		maxTokens: policy.maxTokens,
		modelPolicies: [...modelPolicies]
	};
	if (target === void 0) return base;
	const override = {
		...modelPolicies.find((item) => item.provider === target.provider && item.model === target.model),
		provider: target.provider,
		model: target.model,
		thresholdRatio: policy.thresholdRatio,
		...retention,
		maxTokens: policy.maxTokens
	};
	return {
		...base,
		modelPolicies: [override, ...modelPolicies.filter((item) => item.provider !== target.provider || item.model !== target.model)]
	};
}
/**
* Install once and bridge every compaction provider visible from an agent scope.
*
* DSH Web deliberately disables the host-plane compaction rows and mounts the
* engine plus `/compact` inside the standing Agent preset. Looking up
* `ctx.compaction` here therefore reaches the wrong service (or no service at
* all). The live provider must be resolved through `agent.ctx` after preset
* composition. A standing preset shares one provider between its sessions, so
* calls are serialized around a temporary config swap.
*/
function installSessionCompactionPolicyBridge(ctx, policyFor) {
	const patches = /* @__PURE__ */ new Map();
	const ensureProvider = (agent) => {
		const candidate = agent.ctx.get("compaction");
		if (!isMutableProvider(candidate) || patches.has(candidate)) return;
		const provider = candidate;
		const original = provider.compactIfNeeded;
		const originalNow = provider.compactNow;
		let tail = Promise.resolve();
		const withPolicy = async (agent, signal, operation) => {
			const policy = policyFor(agent);
			const previous = tail;
			let release;
			tail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
			const previousConfig = provider.config;
			const target = routedTarget(agent);
			let contextWindow;
			if (target !== void 0) {
				const llm = agent.ctx.get("llm");
				try {
					contextWindow = (await llm?.resolveModelInfo(target.provider, target.model, signal))?.context?.contextWindow;
				} catch {}
			}
			provider.config = withSessionCompactionPolicy(previousConfig, target, policy, contextWindow);
			try {
				return await operation();
			} finally {
				provider.config = previousConfig;
				release?.();
			}
		};
		const wrappedIfNeeded = async (agent, trigger, signal) => {
			const policy = policyFor(agent);
			if (trigger === "pressure" && !policy.enabled) return null;
			return await withPolicy(agent, signal, () => original.call(provider, agent, trigger, signal));
		};
		const wrappedNow = async (agent, signal, sourceCommandId) => await withPolicy(agent, signal, () => originalNow.call(provider, agent, signal, sourceCommandId));
		provider.compactIfNeeded = wrappedIfNeeded;
		provider.compactNow = wrappedNow;
		patches.set(provider, {
			provider,
			compactIfNeeded: original,
			compactNow: originalNow,
			wrappedIfNeeded,
			wrappedNow
		});
	};
	for (const agent of ctx.agents.roots()) ensureProvider(agent);
	ctx.on("agent/created", ({ agent }) => {
		ensureProvider(agent);
	});
	ctx.on("agent/pre-step", ({ agent }, next) => {
		ensureProvider(agent);
		return next();
	});
	ctx.effect(() => () => {
		for (const patch of patches.values()) {
			if (patch.provider.compactIfNeeded === patch.wrappedIfNeeded) patch.provider.compactIfNeeded = patch.compactIfNeeded;
			if (patch.provider.compactNow === patch.wrappedNow) patch.provider.compactNow = patch.compactNow;
		}
		patches.clear();
	}, "mindspace-session-memory: scoped compaction policy bridges");
}
//#endregion
//#region src/memory/sidecar.ts
/** Durable per-session storage outside DSH's canonical conversation event log. */
function dshHome() {
	return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}
function sessionFilename(id) {
	return `${createHash("sha256").update(id).digest("hex")}.json`;
}
function storedBase(value, sessionId, format) {
	if (value === null || typeof value !== "object") return false;
	const row = value;
	return row["format"] === format && row["sessionId"] === sessionId && row["view"] !== null && typeof row["view"] === "object" && row["compactionPolicy"] !== null && typeof row["compactionPolicy"] === "object";
}
function isStored(value, sessionId) {
	return storedBase(value, sessionId, 5);
}
function isStoredV4(value, sessionId) {
	return storedBase(value, sessionId, 4);
}
function isStoredV3(value, sessionId) {
	return storedBase(value, sessionId, 3);
}
function isStoredV2(value, sessionId) {
	return storedBase(value, sessionId, 2);
}
function migrateActivity(value) {
	if (value === null || typeof value !== "object") return void 0;
	const row = value;
	const oldSection = String(row["section"] ?? "");
	const section = oldSection === "assistantRequirements" || oldSection === "assistantInstructions" ? "assistantRequirements" : oldSection === "roleplayPreset" ? "memories" : "people";
	return {
		...row,
		section,
		mode: row["mode"] === "work" ? "work" : "chat"
	};
}
function legacyMemoryView(events) {
	const preferences = [];
	const requirements = [];
	let relationship = null;
	let lastSeq = -1;
	for (const raw of events) {
		if (raw === null || typeof raw !== "object") continue;
		const event = raw;
		if (typeof event.type !== "string" || !event.type.startsWith("memory/") || event.data === null || typeof event.data !== "object") continue;
		const data = event.data;
		lastSeq = typeof event.seq === "number" ? event.seq : lastSeq;
		if (event.type === "memory/set") {
			const slot = data.slot;
			const target = slot === "preferences" ? preferences : slot === "instructions" ? requirements : void 0;
			const text = typeof data.text === "string" ? data.text.trim() : "";
			if (target === void 0 || text === "") continue;
			const id = typeof data.id === "string" && data.id.trim() ? data.id : `legacy-${slot}-${lastSeq}`;
			const next = {
				id,
				category: typeof data.category === "string" && data.category.trim() ? data.category : slot === "preferences" ? "综合偏好" : "对AI的要求",
				text,
				source: data.source === "extracted" ? "extracted" : "user",
				evidenceSeqs: typeof data.evidenceSeq === "number" ? [data.evidenceSeq] : []
			};
			const at = target.findIndex((item) => item.id === id);
			if (at >= 0) target.splice(at, 1, next);
			else target.push(next);
		} else if (event.type === "memory/remove" && typeof data.id === "string") {
			const target = data.slot === "preferences" ? preferences : data.slot === "instructions" ? requirements : void 0;
			if (target !== void 0) {
				const at = target.findIndex((item) => item.id === data.id);
				if (at >= 0) target.splice(at, 1);
			}
		} else if (event.type === "memory/relationship") {
			const status = typeof data.role === "string" ? data.role.trim() : "";
			if (status) relationship = {
				status,
				context: [typeof data.personaText === "string" ? data.personaText.trim() : "", typeof data.mission === "string" && data.mission.trim() ? `历史背景：${data.mission.trim()}` : ""].filter(Boolean).join("；"),
				updatedAt: Date.now()
			};
		}
	}
	if (lastSeq < 0) return {
		view: {
			document: emptySessionMemory(),
			memoryActivity: []
		},
		lastSeq
	};
	return {
		view: {
			document: migrateV3Document({
				version: 3,
				revision: 1,
				userProfile: {
					confirmed: "",
					pendingConfirmation: "",
					confirmedEvidenceSeqs: [],
					pendingEvidenceSeqs: []
				},
				preferences,
				assistantRequirements: requirements,
				relationship,
				roleplayPreset: null,
				updatedAt: Date.now()
			}),
			memoryActivity: []
		},
		lastSeq
	};
}
function importedView(session) {
	const modern = foldSessionMemory(session.events);
	const modernSeq = session.events.findLast((event) => event.type === "session-memory/change")?.seq ?? -1;
	const legacy = legacyMemoryView(session.events);
	return legacy.lastSeq > modernSeq ? legacy.view : modern;
}
var SessionMemorySidecar = class {
	root = join(dshHome(), "mindspace-session-memory", "v1");
	cache = /* @__PURE__ */ new Map();
	read(session) {
		const cached = this.cache.get(session.id);
		if (cached !== void 0) return cached;
		const path = this.pathFor(session.id);
		if (existsSync(path)) try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (isStored(parsed, session.id)) {
				const stored = {
					...parsed,
					compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy)
				};
				this.cache.set(session.id, stored);
				return stored;
			}
			if (isStoredV4(parsed, session.id) || isStoredV3(parsed, session.id) || isStoredV2(parsed, session.id)) {
				const document = parsed.format === 4 ? migrateV4Document(parsed.view.document) : parsed.format === 3 ? migrateV3Document(parsed.view.document) : migrateV2Document(parsed.view.document);
				const migrated = {
					format: 5,
					sessionId: session.id,
					view: {
						document,
						memoryActivity: parsed.view.memoryActivity.map(migrateActivity).filter((item) => item !== void 0)
					},
					compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy),
					writtenAt: Date.now()
				};
				this.write(migrated);
				return migrated;
			}
		} catch {}
		const imported = {
			format: 5,
			sessionId: session.id,
			view: importedView(session),
			compactionPolicy: foldCompactionPolicy(session.events),
			writtenAt: Date.now()
		};
		this.write(imported);
		return imported;
	}
	replace(session, view) {
		const next = {
			...this.read(session),
			view,
			writtenAt: Date.now()
		};
		this.write(next);
		return next;
	}
	setPolicy(session, policy) {
		const next = {
			...this.read(session),
			compactionPolicy: normalizeCompactionPolicy(policy),
			writtenAt: Date.now()
		};
		this.write(next);
		return next;
	}
	pathFor(sessionId) {
		return join(this.root, sessionFilename(sessionId));
	}
	write(value) {
		mkdirSync(this.root, { recursive: true });
		const target = this.pathFor(value.sessionId);
		const temporary = join(this.root, `.${sessionFilename(value.sessionId)}.${randomUUID()}.tmp`);
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
			encoding: "utf8",
			flag: "wx"
		});
		renameSync(temporary, target);
		this.cache.set(value.sessionId, value);
	}
};
//#endregion
//#region src/memory/mutation.ts
/** Pure, atomic mutations for one Chat or Work memory face. */
const MAX_PEOPLE$1 = 5;
const MAX_MEMORY_CARDS$1 = 3;
function upsertCard(entries, args, sourceSeqs) {
	if (!args.text?.trim() || !args.category?.trim()) throw new Error("category and text are required");
	const next = [...entries];
	const at = args.item_id ? next.findIndex((item) => item.id === args.item_id) : next.findIndex((item) => item.category.toLocaleLowerCase() === args.category.trim().toLocaleLowerCase());
	const value = {
		id: next[at]?.id ?? `memory-${randomUUID()}`,
		category: args.category.trim(),
		text: args.text.trim(),
		source: "user",
		evidenceSeqs: [.../* @__PURE__ */ new Set([...next[at]?.evidenceSeqs ?? [], ...sourceSeqs])]
	};
	if (at >= 0) next.splice(at, 1, value);
	else if (next.length < MAX_MEMORY_CARDS$1) next.push(value);
	else next.splice(next.reduce((best, item, index) => item.text.length < next[best].text.length ? index : best, 0), 1, value);
	return next;
}
function applyMemoryMutation(mode, args, sourceSeqs) {
	if (args.action === "set_assistant_setting") {
		if (args.assistant_setting === void 0) throw new Error("assistant_setting is required");
		return {
			...mode,
			assistantSetting: args.assistant_setting.trim()
		};
	}
	if (args.action === "set_assistant_state") {
		if (args.assistant_state === void 0) throw new Error("assistant_state is required");
		return {
			...mode,
			assistantState: args.assistant_state.trim()
		};
	}
	if (args.action === "add_person") {
		if (!args.person_name?.trim()) throw new Error("person_name is required");
		if (mode.people.length >= MAX_PEOPLE$1) throw new Error(`people already has ${MAX_PEOPLE$1} entries`);
		return {
			...mode,
			people: [...mode.people, {
				id: `person-${randomUUID()}`,
				name: args.person_name.trim(),
				information: args.information ?? "",
				preference: args.preference ?? "",
				relationship: args.relationship ?? "",
				source: "user",
				evidenceSeqs: [...sourceSeqs],
				updatedAt: Date.now()
			}]
		};
	}
	if (args.action === "update_person" || args.action === "remove_person") {
		if (!args.person_id) throw new Error("person_id is required");
		const people = [...mode.people];
		const at = people.findIndex((person) => person.id === args.person_id);
		if (at < 0) throw new Error(`person not found: ${args.person_id}`);
		if (args.action === "remove_person") people.splice(at, 1);
		else {
			const old = people[at];
			people.splice(at, 1, {
				...old,
				name: args.person_name ?? old.name,
				information: args.information ?? old.information,
				preference: args.preference ?? old.preference,
				relationship: args.relationship ?? old.relationship,
				source: "user",
				evidenceSeqs: [.../* @__PURE__ */ new Set([...old.evidenceSeqs, ...sourceSeqs])],
				updatedAt: Date.now()
			});
		}
		return {
			...mode,
			people
		};
	}
	if (!args.section) throw new Error("section is required");
	if (args.action === "upsert_item") return {
		...mode,
		[args.section]: upsertCard(mode[args.section], args, sourceSeqs)
	};
	const entries = [...mode[args.section]];
	const at = args.item_id ? entries.findIndex((item) => item.id === args.item_id) : entries.findIndex((item) => item.category.toLocaleLowerCase() === args.category?.trim().toLocaleLowerCase());
	if (at < 0) throw new Error("matching item not found");
	entries.splice(at, 1);
	return {
		...mode,
		[args.section]: entries
	};
}
function mutationInstruction(args) {
	if (args.action === "set_assistant_setting") return `更新 AI 设定：${args.assistant_setting ?? ""}`;
	if (args.action === "set_assistant_state") return `更新 AI 当前状态：${args.assistant_state ?? ""}`;
	if (args.action.includes("person")) return `${args.action}：${args.person_name ?? args.person_id ?? ""}；信息=${args.information ?? ""}；偏好=${args.preference ?? ""}；关系=${args.relationship ?? ""}`;
	return `${args.action} ${args.section ?? ""} / ${args.category ?? args.item_id ?? ""}：${args.text ?? ""}`;
}
//#endregion
//#region src/memory/render.ts
const numerals = [
	"一",
	"二",
	"三",
	"四",
	"五"
];
function cards(label, values) {
	return values.length === 0 ? "" : `${label}：\n${values.map((value) => `- ${value.category}：${value.text}`).join("\n")}`;
}
function renderAssistantRequirements(view, mode = view.document.activeMode) {
	return cards("对 AI 的要求", view.document[mode].assistantRequirements);
}
function renderSessionMemoryContext(view, mode = view.document.activeMode) {
	const state = view.document[mode];
	const people = state.people.map((person, index) => [
		`人物${numerals[index] ?? index + 1}`,
		`个体名称：${person.name}`,
		person.information ? `${mode === "chat" ? "日常信息" : "工作信息"}：${person.information}` : "",
		person.preference ? `${mode === "chat" ? "日常偏好" : "工作偏好"}：${person.preference}` : "",
		person.relationship ? `${mode === "chat" ? "与当前 AI 的关系" : "协作关系"}：${person.relationship}` : ""
	].filter(Boolean).join("\n")).join("\n\n");
	return [
		`当前记忆模式：${mode === "chat" ? "Chat（日常）" : "Work（工作）"}。这只是上下文状态，不限制任何工具或行为。`,
		"记忆职责：用户明确确认或改变人物、关系、称呼、稳定偏好、对 AI 的规则、长期事实或 AI 当前状态时，必须在本轮调用 update_session_memory 落盘；“这身”“就这样”“以后照此”等确认应结合紧邻上下文解析。普通闲聊、一次性动作和未经确认的猜测不写入。",
		people ? `人物信息：\n${people}` : "",
		state.assistantSetting ? `AI 设定：${state.assistantSetting}` : "",
		state.assistantState ? `${mode === "chat" ? "AI 当前衣着与外观" : "AI 当前工作状态"}：${state.assistantState}` : "",
		cards(mode === "chat" ? "长期日常记忆" : "长期工作记忆", state.memories)
	].filter(Boolean).join("\n\n");
}
function renderBridge(view) {
	const bridge = view.document.bridge;
	return [bridge.transitionNote ? `最近转场：${bridge.transitionNote}` : "", bridge.pendingWrites.length ? `待目标模式处理的跨域写入：${bridge.pendingWrites.map((item) => `${item.id} -> ${item.targetMode}: ${item.instruction}`).join("；")}` : ""].filter(Boolean).join("\n");
}
function renderSessionMemory(view, mode = view.document.activeMode) {
	return [
		renderAssistantRequirements(view, mode),
		renderSessionMemoryContext(view, mode),
		renderBridge(view)
	].filter(Boolean).join("\n\n");
}
/** Compact tool-facing state. Full activity history belongs to the Memory Center, not model context. */
function modelSessionMemorySnapshot(view) {
	const { document } = view;
	return {
		activeMode: document.activeMode,
		modeSource: document.modeSource,
		modeReason: document.modeReason,
		memory: document[document.activeMode],
		bridge: document.bridge
	};
}
//#endregion
//#region src/memory/state-reminder.ts
const ASSISTANT_STATE_SUBJECT = /(外观|衣着|穿着|穿上|换上|换成|换衣|换装|这身|那身|衣服|衬衫|裙|丝袜|浴巾|发型|头发|妆容|当前状态)/u;
const ASSISTANT_STATE_CHANGE = /(现在|目前|已经|还是|没有|没|不再|保持|继续|改|变|换|穿|脱|就是|恢复|回到|记住|确认)/u;
/** Keep the write duty adjacent to state-changing user text instead of burying it in a long system prompt. */
function needsAssistantStateReminder(messages) {
	const latest = messages.findLast((message) => message.source.kind === "user");
	if (latest === void 0) return false;
	const text = latest.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return ASSISTANT_STATE_SUBJECT.test(text) && ASSISTANT_STATE_CHANGE.test(text);
}
const ASSISTANT_STATE_REMINDER = {
	content: [{
		type: "text",
		text: "<session-memory-duty>This message may confirm, correct, or change the AI current appearance/outfit/state. Before narrating a state as real, inspect it with get_current_assistant_state when disputed, then persist the resolved current state with set_current_assistant_state. Prose alone does not change memory.</session-memory-duty>"
	}],
	source: {
		kind: "plugin",
		plugin: "mindspace-session-memory",
		form: "notice",
		summary: "current-state write duty"
	},
	role: "user",
	id: "session-memory-current-state-duty"
};
//#endregion
//#region src/memory/index.ts
/** Session-isolated Chat/Work memory with a neutral two-slot bridge. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const MAX_PEOPLE = 5;
const MAX_MEMORY_CARDS = 3;
const DEFAULT_PROFILE_CHARACTERS = 300;
const MEMORY_TOOL_GUIDANCE = [
	"Session memory has two task-conditioned faces for the same user and AI: Chat for daily life, relationships, preferences and appearance; Work for projects, engineering and collaboration.",
	"These modes never restrict tools or capabilities. At the start of a turn, keep the current mode when it fits; call route_session_memory only when the latest user intent clearly belongs to the other mode.",
	"A user-selected mode is strong evidence, not an absolute lock. A mixed message may switch once its main intent changes. The route tool returns the newly relevant memory and pending bridge writes.",
	"Memory write duty: when the user explicitly establishes, confirms, corrects, or changes a person, relationship, name, durable preference, instruction for the AI, long-lived fact, or the AI current state, call update_session_memory in that same turn. The user does not need to say \"remember\". Resolve confirmations such as \"this outfit\", \"keep it this way\", or \"do this from now on\" from the immediately preceding context.",
	"For the AI current Chat appearance/outfit or current Work role/state, prefer the dedicated get_current_assistant_state and set_current_assistant_state tools. Use update_session_memory set_assistant_setting for the stable AI definition. Do not merely enact a confirmed state in prose: persist it as part of completing the request.",
	"Ordinary small talk, momentary actions, one-off tasks, and unconfirmed guesses are not memory. Direct writes are atomic and do not require a preceding read; use get_session_memory only when the existing state or ids are genuinely needed.",
	"Verification duty: when the user asks what is currently remembered or disputes a general remembered fact, call get_session_memory before answering; for current AI appearance/outfit/state use get_current_assistant_state. Treat tool results as authoritative. If a field is empty or inconsistent, say so and persist a user-confirmed correction instead of claiming that prose already changed memory.",
	"Direct writes may only target the active mode. A fact for the other mode must be staged with update_session_memory target_mode; do not place it in the current mode.",
	"After entering a mode, review pending writes targeted there. Use resolve_pending_memory to apply a consolidated update or explicitly skip it; only then is that pending item cleared.",
	"The bridge contains only a short transition note and pending write instructions. Never use it as a second long-term memory. Never invent people or facts."
].join(" ");
function failure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
function validateText(value, field, maxBytes, allowBlank = false) {
	if (!allowBlank && !value.trim()) return {
		code: "invalid-document",
		message: `${field} must not be blank`
	};
	return Buffer.byteLength(value, "utf8") > maxBytes ? {
		code: "text-too-large",
		message: `${field} exceeds ${maxBytes} bytes`
	} : void 0;
}
function validateItems(items, field, config) {
	if (items.length > config.maxItemsPerSection) return {
		code: "invalid-document",
		message: `${field} has more than ${config.maxItemsPerSection} cards`
	};
	const ids = /* @__PURE__ */ new Set();
	const categories = /* @__PURE__ */ new Set();
	for (const [index, item] of items.entries()) {
		for (const [name, value] of [
			["id", item.id],
			["category", item.category],
			["text", item.text]
		]) {
			const invalid = validateText(value, `${field}[${index}].${name}`, config.maxTextBytes);
			if (invalid) return invalid;
		}
		const category = item.category.trim().toLocaleLowerCase();
		if (ids.has(item.id) || categories.has(category)) return {
			code: "invalid-document",
			message: `${field} contains a duplicate id or category`
		};
		ids.add(item.id);
		categories.add(category);
	}
}
function validateMode(mode, field, config) {
	if (mode.people.length > MAX_PEOPLE) return {
		code: "invalid-document",
		message: `${field}.people exceeds ${MAX_PEOPLE}`
	};
	for (const [index, person] of mode.people.entries()) {
		const id = validateText(person.id, `${field}.people[${index}].id`, config.maxTextBytes);
		if (id) return id;
		const name = validateText(person.name, `${field}.people[${index}].name`, config.maxTextBytes);
		if (name) return name;
		if ([...person.information].length > config.maxProfileCharacters || [...person.preference].length > config.maxProfileCharacters) return {
			code: "text-too-large",
			message: `${field}.people[${index}] profile exceeds ${config.maxProfileCharacters} characters`
		};
	}
	for (const [name, value] of [["assistantSetting", mode.assistantSetting], ["assistantState", mode.assistantState]]) {
		const invalid = validateText(value, `${field}.${name}`, config.maxTextBytes, true);
		if (invalid) return invalid;
	}
	return validateItems(mode.assistantRequirements, `${field}.assistantRequirements`, config) ?? validateItems(mode.memories, `${field}.memories`, config);
}
function resolveDocument(request, revision, time, config) {
	const chatInvalid = validateMode(request.chat, "chat", config);
	if (chatInvalid) return chatInvalid;
	const workInvalid = validateMode(request.work, "work", config);
	if (workInvalid) return workInvalid;
	if ([...request.bridge.transitionNote].length > 300) return {
		code: "text-too-large",
		message: "bridge.transitionNote exceeds 300 characters"
	};
	for (const item of request.bridge.pendingWrites) {
		const invalid = validateText(item.instruction, "bridge.pendingWrites.instruction", config.maxTextBytes);
		if (invalid) return invalid;
	}
	return normalizeSessionMemoryDocument({
		version: 5,
		revision,
		activeMode: request.activeMode,
		modeSource: request.modeSource,
		modeReason: request.modeReason,
		chat: request.chat,
		work: request.work,
		bridge: request.bridge,
		updatedAt: time
	});
}
function activity(operation, section, mode, before, after, reason, at, sourceSeqs = []) {
	const show = (value) => value === null || value === void 0 ? null : typeof value === "string" ? value : JSON.stringify(value);
	return {
		id: `activity-${randomUUID()}`,
		operation,
		section,
		mode,
		before: show(before),
		after: show(after),
		reason,
		at,
		sourceSeqs: [...sourceSeqs]
	};
}
function audit(current, next, at) {
	const rows = [];
	if (current.activeMode !== next.activeMode) rows.push(activity("switch", "bridge", next.activeMode, current.activeMode, next.activeMode, next.modeReason || "Mode changed", at));
	for (const mode of ["chat", "work"]) for (const section of [
		"people",
		"assistantSetting",
		"assistantState",
		"assistantRequirements",
		"memories"
	]) if (JSON.stringify(current[mode][section]) !== JSON.stringify(next[mode][section])) rows.push(activity("replace", section, mode, current[mode][section], next[mode][section], "Memory center updated this field.", at));
	if (current.bridge.transitionNote !== next.bridge.transitionNote) rows.push(activity("replace", "bridge", null, current.bridge.transitionNote, next.bridge.transitionNote, "Transition note updated.", at));
	const previousPending = new Map(current.bridge.pendingWrites.map((item) => [item.id, item]));
	const nextPending = new Map(next.bridge.pendingWrites.map((item) => [item.id, item]));
	for (const item of next.bridge.pendingWrites) if (!previousPending.has(item.id)) rows.push(activity("stage", "bridge", item.targetMode, null, item.instruction, "Cross-domain write staged for its target mode.", at, item.sourceSeqs));
	for (const item of current.bridge.pendingWrites) if (!nextPending.has(item.id)) rows.push(activity("consume", "bridge", item.targetMode, item.instruction, null, "Pending cross-domain write resolved.", at, item.sourceSeqs));
	return rows;
}
function currentRequest(document) {
	return {
		expectedRevision: document.revision,
		activeMode: document.activeMode,
		modeSource: document.modeSource,
		modeReason: document.modeReason,
		chat: document.chat,
		work: document.work,
		bridge: document.bridge
	};
}
let SessionMemoryService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _get_decorators;
	let _replace_decorators;
	let _getCompactionPolicy_decorators;
	let _getCompactionStatus_decorators;
	let _setCompactionPolicy_decorators;
	return class SessionMemoryService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_get_decorators = [Remote("get")];
			_replace_decorators = [Remote("replace")];
			_getCompactionPolicy_decorators = [Remote("getCompactionPolicy")];
			_getCompactionStatus_decorators = [Remote("getCompactionStatus")];
			_setCompactionPolicy_decorators = [Remote("setCompactionPolicy")];
			__esDecorate(this, null, _get_decorators, {
				kind: "method",
				name: "get",
				static: false,
				private: false,
				access: {
					has: (obj) => "get" in obj,
					get: (obj) => obj.get
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _replace_decorators, {
				kind: "method",
				name: "replace",
				static: false,
				private: false,
				access: {
					has: (obj) => "replace" in obj,
					get: (obj) => obj.replace
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getCompactionPolicy_decorators, {
				kind: "method",
				name: "getCompactionPolicy",
				static: false,
				private: false,
				access: {
					has: (obj) => "getCompactionPolicy" in obj,
					get: (obj) => obj.getCompactionPolicy
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getCompactionStatus_decorators, {
				kind: "method",
				name: "getCompactionStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getCompactionStatus" in obj,
					get: (obj) => obj.getCompactionStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setCompactionPolicy_decorators, {
				kind: "method",
				name: "setCompactionPolicy",
				static: false,
				private: false,
				access: {
					has: (obj) => "setCompactionPolicy" in obj,
					get: (obj) => obj.setCompactionPolicy
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"agents",
			"sessions",
			"tools",
			"systemPrompt",
			"typert",
			"commands"
		];
		static Config = z.object({
			maxTextBytes: z.number().step(1).min(1).default(4096),
			maxItemsPerSection: z.number().step(1).min(1).max(MAX_MEMORY_CARDS).default(MAX_MEMORY_CARDS),
			maxProfileCharacters: z.number().step(1).min(1).default(DEFAULT_PROFILE_CHARACTERS)
		});
		resolved = __runInitializers(this, _instanceExtraInitializers);
		installedAgents = /* @__PURE__ */ new WeakSet();
		store = new SessionMemorySidecar();
		requestCompactionCheck;
		constructor(ctx, config = {}) {
			super(ctx, "mindspaceSessionMemory");
			ctx.typert.register(TYPERT);
			this.resolved = {
				maxTextBytes: config.maxTextBytes ?? 4096,
				maxItemsPerSection: Math.min(config.maxItemsPerSection ?? MAX_MEMORY_CARDS, MAX_MEMORY_CARDS),
				maxProfileCharacters: config.maxProfileCharacters ?? DEFAULT_PROFILE_CHARACTERS
			};
			ctx.systemPrompt.section({
				name: "tool:session-memory",
				order: 113,
				text: MEMORY_TOOL_GUIDANCE
			});
			this.registerTools();
			ctx.on("agent/pre-step", async ({ messages, step }, next) => {
				const decision = await next();
				if (step !== 1 || decision.kind === "reject" || !needsAssistantStateReminder(messages)) return decision;
				return {
					kind: "enter",
					messages: [...decision.messages, {
						...ASSISTANT_STATE_REMINDER,
						id: `${ASSISTANT_STATE_REMINDER.id}-${randomUUID()}`
					}]
				};
			});
			installSessionCompactionPolicyBridge(ctx, (agent) => this.store.read(agent.session).compactionPolicy);
			this.requestCompactionCheck = installAutomaticCompactionFallback(ctx, (agent) => this.store.read(agent.session).compactionPolicy);
			ctx.inject(["systemPrompt"], (promptCtx) => {
				for (const agent of ctx.agents.roots()) this.installPrompt(agent);
				promptCtx.on("agent/created", ({ agent }) => {
					if (ctx.agents.roots().includes(agent)) this.installPrompt(agent);
				});
			});
		}
		get(agent) {
			this.assertLive(agent);
			return this.store.read(agent.session).view;
		}
		async replace(agent, request) {
			return this.commit(agent, request, []);
		}
		getCompactionPolicy(agent) {
			this.assertLive(agent);
			return normalizeCompactionPolicy(this.store.read(agent.session).compactionPolicy);
		}
		async getCompactionStatus(agent) {
			this.assertLive(agent);
			return await readSessionCompactionStatus(agent, this.store.read(agent.session).compactionPolicy, this.ctx.get("commands") !== void 0);
		}
		async setCompactionPolicy(agent, policy) {
			this.assertLive(agent);
			const next = {
				...normalizeCompactionPolicy(policy),
				updatedAt: Date.now()
			};
			const saved = this.store.setPolicy(agent.session, next).compactionPolicy;
			this.requestCompactionCheck(agent);
			return saved;
		}
		async commit(agent, request, sourceSeqs) {
			this.assertLive(agent);
			const currentView = this.get(agent);
			const current = currentView.document;
			if (request.expectedRevision !== current.revision) return failure("stale-revision", `expected revision ${request.expectedRevision}; current revision is ${current.revision}`);
			const time = Date.now();
			const resolved = resolveDocument(request, current.revision + 1, time, this.resolved);
			if ("code" in resolved) return {
				ok: false,
				error: resolved
			};
			const changes = audit(current, resolved, time);
			if (!changes.length) return {
				ok: true,
				value: currentView
			};
			const view = {
				document: resolved,
				memoryActivity: [...currentView.memoryActivity, ...changes.map((change) => ({
					...change,
					sourceSeqs: [.../* @__PURE__ */ new Set([...change.sourceSeqs, ...sourceSeqs])]
				}))]
			};
			this.store.replace(agent.session, view);
			return {
				ok: true,
				value: view
			};
		}
		assertLive(agent) {
			if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`);
		}
		latestEvidence(agent) {
			const event = agent.session.events.findLast((row) => row.type === "user/message" && row.data.source.kind === "user");
			return event ? [event.seq] : [];
		}
		registerTools() {
			this.ctx.tools.register(defineTool({
				name: "route_session_memory",
				description: "Switch Chat/Work memory only when the latest intent clearly belongs to the other mode. This does not change tools or permissions. Returns the selected mode memory and pending bridge writes.",
				parameters: {
					mode: {
						type: "string",
						required: true,
						enum: ["chat", "work"]
					},
					reason: {
						type: "string",
						required: true,
						description: "Brief semantic reason for keeping or changing mode."
					},
					transition_note: {
						type: "string",
						description: "When switching, <=300 characters: why, destination, and where the previous state stopped."
					}
				},
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: async (args, exec) => {
					if (!exec.agent) throw new Error("route_session_memory requires an Agent-backed session");
					const view = this.get(exec.agent);
					const mode = args.mode;
					if (mode !== view.document.activeMode) {
						const request = currentRequest(view.document);
						const result = await this.commit(exec.agent, {
							...request,
							activeMode: mode,
							modeSource: "model",
							modeReason: args.reason,
							bridge: {
								...request.bridge,
								transitionNote: [...args.transition_note ?? `${view.document.activeMode} → ${mode}：${args.reason}`].slice(0, 300).join("")
							}
						}, this.latestEvidence(exec.agent));
						if (!result.ok) throw new Error(result.error.message);
						return {
							mode,
							memory: renderSessionMemory(result.value, mode),
							pendingWrites: result.value.document.bridge.pendingWrites.filter((item) => item.targetMode === mode)
						};
					}
					return {
						mode,
						memory: renderSessionMemory(view, mode),
						pendingWrites: view.document.bridge.pendingWrites.filter((item) => item.targetMode === mode)
					};
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "get_session_memory",
				description: "Inspect the authoritative active memory. Required before answering a user question or dispute about what is currently stored. Returns only the compact active-mode state and bridge; audit history stays in the Memory Center.",
				parameters: {},
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: (_args, exec) => {
					if (!exec.agent) throw new Error("get_session_memory requires an Agent-backed session");
					return Promise.resolve(modelSessionMemorySnapshot(this.get(exec.agent)));
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "get_current_assistant_state",
				description: "Read the authoritative current AI appearance, outfit, or active role/state. Call this when the user says the claimed state is not visible, unchanged, or inconsistent.",
				parameters: {},
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: (_args, exec) => {
					if (!exec.agent) throw new Error("get_current_assistant_state requires an Agent-backed session");
					const document = this.get(exec.agent).document;
					return Promise.resolve({
						mode: document.activeMode,
						state: document[document.activeMode].assistantState
					});
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "set_current_assistant_state",
				description: "Persist the AI current appearance/outfit or active role/state in the active Chat/Work memory. Required before claiming a confirmed change is now in effect. This is the simple preferred state-write tool.",
				parameters: { state: {
					type: "string",
					required: true,
					description: "The complete resolved current state. Use an empty string only when the user explicitly clears it."
				} },
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: async (args, exec) => {
					if (!exec.agent) throw new Error("set_current_assistant_state requires an Agent-backed session");
					const current = this.get(exec.agent).document;
					const sourceSeqs = this.latestEvidence(exec.agent);
					const request = currentRequest(current);
					const target = applyMemoryMutation(current[current.activeMode], {
						action: "set_assistant_state",
						assistant_state: args.state
					}, sourceSeqs);
					const result = await this.commit(exec.agent, {
						...request,
						[current.activeMode]: target
					}, sourceSeqs);
					if (!result.ok) throw new Error(result.error.message);
					const document = result.value.document;
					return {
						ok: true,
						mode: document.activeMode,
						state: document[document.activeMode].assistantState,
						revision: document.revision
					};
				}
			}));
			const mutationParameters = {
				target_mode: {
					type: "string",
					required: true,
					enum: ["chat", "work"]
				},
				action: {
					type: "string",
					required: true,
					enum: [
						"set_assistant_setting",
						"set_assistant_state",
						"add_person",
						"update_person",
						"remove_person",
						"upsert_item",
						"remove_item"
					]
				},
				section: {
					type: "string",
					enum: ["assistantRequirements", "memories"]
				},
				category: { type: "string" },
				text: { type: "string" },
				item_id: { type: "string" },
				person_id: { type: "string" },
				person_name: { type: "string" },
				information: { type: "string" },
				preference: { type: "string" },
				relationship: { type: "string" },
				assistant_setting: { type: "string" },
				assistant_state: { type: "string" }
			};
			this.ctx.tools.register(defineTool({
				name: "update_session_memory",
				description: "Persist an explicit memory change now in one atomic call, or stage it for the other mode. Use set_assistant_state whenever the user confirms or changes the AI current Chat outfit/appearance or Work role/state; acting it out only in prose is incomplete. A prior get_session_memory call is optional.",
				parameters: mutationParameters,
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: async (raw, exec) => {
					if (!exec.agent) throw new Error("update_session_memory requires an Agent-backed session");
					const current = this.get(exec.agent).document;
					const args = raw;
					const sourceSeqs = this.latestEvidence(exec.agent);
					const request = currentRequest(current);
					let next;
					if (args.target_mode === current.activeMode) next = {
						...request,
						[args.target_mode]: applyMemoryMutation(current[args.target_mode], args, sourceSeqs)
					};
					else {
						const pending = {
							id: `pending-${randomUUID()}`,
							fromMode: current.activeMode,
							targetMode: args.target_mode,
							instruction: mutationInstruction(args),
							suggestedAction: args.action,
							...args.section ? { suggestedSection: args.section } : {},
							sourceSeqs,
							createdAt: Date.now()
						};
						next = {
							...request,
							bridge: {
								...request.bridge,
								pendingWrites: [...request.bridge.pendingWrites, pending]
							}
						};
					}
					const result = await this.commit(exec.agent, next, sourceSeqs);
					if (!result.ok) throw new Error(result.error.message);
					return {
						ok: true,
						...modelSessionMemorySnapshot(result.value),
						revision: result.value.document.revision
					};
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "resolve_pending_memory",
				description: "After entering a target mode, apply one reviewed pending write with a consolidated mutation, or skip it. Clears only that successfully resolved item.",
				parameters: {
					pending_id: {
						type: "string",
						required: true
					},
					resolution: {
						type: "string",
						required: true,
						enum: ["apply", "skip"]
					},
					reason: {
						type: "string",
						required: true
					},
					...mutationParameters
				},
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: async (raw, exec) => {
					if (!exec.agent) throw new Error("resolve_pending_memory requires an Agent-backed session");
					const args = raw;
					const view = this.get(exec.agent);
					const pending = view.document.bridge.pendingWrites.find((item) => item.id === args.pending_id);
					if (!pending) throw new Error("pending write not found");
					if (pending.targetMode !== view.document.activeMode || args.target_mode !== pending.targetMode) throw new Error("Switch to the pending write target mode first");
					const sourceSeqs = [.../* @__PURE__ */ new Set([...pending.sourceSeqs, ...this.latestEvidence(exec.agent)])];
					const request = currentRequest(view.document);
					const target = args.resolution === "apply" ? applyMemoryMutation(view.document[pending.targetMode], args, sourceSeqs) : view.document[pending.targetMode];
					const next = {
						...request,
						[pending.targetMode]: target,
						bridge: {
							...request.bridge,
							pendingWrites: request.bridge.pendingWrites.filter((item) => item.id !== pending.id)
						}
					};
					const result = await this.commit(exec.agent, next, sourceSeqs);
					if (!result.ok) throw new Error(result.error.message);
					return {
						ok: true,
						...modelSessionMemorySnapshot(result.value),
						revision: result.value.document.revision
					};
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "configure_context_compaction",
				description: "Configure context compaction for this conversation only.",
				parameters: {
					enabled: {
						type: "boolean",
						required: true
					},
					threshold_percent: { type: "number" },
					retain_tokens: { type: "number" },
					summary_max_tokens: { type: "number" }
				},
				output: {
					schema: { type: "json" },
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value)
					}]
				},
				execute: async (args, exec) => {
					if (!exec.agent) throw new Error("Agent-backed session required");
					return await this.setCompactionPolicy(exec.agent, {
						version: 1,
						enabled: args.enabled,
						thresholdRatio: (args.threshold_percent ?? 16.4) / 100,
						retainTokens: args.retain_tokens ?? 64e3,
						maxTokens: args.summary_max_tokens ?? 6e3,
						updatedAt: Date.now()
					});
				}
			}));
		}
		installPrompt(agent) {
			if (this.installedAgents.has(agent)) return;
			this.installedAgents.add(agent);
			agent.ctx.systemPrompt.section({
				name: PERSONA_SECTION,
				order: PERSONA_ORDER,
				text: () => renderAssistantRequirements(this.get(agent))
			});
			agent.ctx.systemPrompt.section({
				name: "session-memory:personalization",
				order: 10,
				text: () => renderSessionMemoryContext(this.get(agent))
			});
			agent.ctx.systemPrompt.section({
				name: "session-memory:bridge",
				order: 11,
				text: () => renderBridge(this.get(agent))
			});
		}
	};
})();
//#endregion
export { renderBridge as a, applySessionMemoryEvent as c, emptySessionMemoryFoldState as d, foldSessionMemory as f, sessionMemoryView as h, renderAssistantRequirements as i, emptyModeMemory as l, migrateV4Document as m, SessionMemoryService as n, renderSessionMemory as o, migrateLegacyDocument as p, needsAssistantStateReminder as r, renderSessionMemoryContext as s, MEMORY_TOOL_GUIDANCE as t, emptySessionMemory as u };
