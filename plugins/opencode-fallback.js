// opencode-fallback — V2-native port of the V1 package `opencode-fallback@1.2.0`.
//
// Why this file exists: OpenCode V2 dropped the V1 plugin API. The published
// package still exports a V1 `createPlugin(context) => Hooks` function, so V2
// refuses it with:
//   "Plugin must export a default definition with an id and an effect or setup function."
// This file is the same feature set rewritten against the V2 plugin contract:
//   `export default { id, setup(ctx) }` — auto-discovered from
//   ~/.config/opencode/plugins/ (no config entry needed).
//
// Behavior (matches the V1 plugin, minus the Ralph loop):
//   * rate-limit recovery — a terminal provider failure matching
//     rateLimitPatterns switches the session to `fallbackModel` and re-prompts
//     with the partial output (or a continue-nudge) so the turn completes on
//     another model.
//   * disconnect recovery — a terminal stream/provider failure matching
//     disconnectPatterns re-prompts the same model (first attempt) and
//     escalates to `fallbackModel` on repeat failures, with exponential backoff.
//   * cooldowns + attempt caps so a dead provider cannot cause a prompt storm.
//   * everything is logged to ~/.local/share/opencode/log/fallback.log.
//
// Config: same file as V1 — ~/.config/opencode/fallback.json (or
// rate-limit-fallback.json, also searched in config/ plugins/ plugin/).
// All V1 keys are honored except the loop keys (loopEnabled / loopStartPhrase /
// loopStopPhrase / loopPrompt) — not ported to V2; a note is logged when set.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
  : path.join(os.homedir(), ".config", "opencode")
const DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
const LOG_PATH = path.join(DATA_HOME, "opencode", "log", "fallback.log")

const DEFAULT_RATE_PATTERNS = ["rate limit", "usage limit", "too many requests", "quota exceeded"]
const DEFAULT_DISCONNECT_PATTERNS = [
  "overloaded", "service unavailable", "bad gateway", "internal server error",
  "connection reset", "connection closed", "econnreset", "econnaborted",
  "socket hang up", "network error", "reset by peer", "broken pipe",
  "upstream connect error", "stream error", "unexpected end", "premature close",
  "disconnected", "request timed out", "connection timed out", "response timeout",
  "502", "503", "529",
]
const DEFAULT_CONTINUATION_TEMPLATE =
  "Your previous response was interrupted mid-stream by a provider error. " +
  "Here is exactly what you had generated before the interruption:\n\n" +
  "---BEGIN PARTIAL RESPONSE---\n{{partial_content}}\n---END PARTIAL RESPONSE---\n\n" +
  "Continue your response EXACTLY where it was cut off. Do not repeat any of the content above. " +
  "Do not acknowledge the interruption. Just seamlessly continue from the exact point where the text ends."
const DEFAULT_NUDGE =
  "Your previous attempt failed before any output was produced ({reason}). " +
  "Fulfil my last request again from the top. Do not mention this message."

const CONFIG_FILENAMES = ["fallback.json", "rate-limit-fallback.json"]
const SEARCH_SUBDIRS = ["config", "plugins", "plugin"]

function loadConfig() {
  let found = null
  for (const name of CONFIG_FILENAMES) {
    const candidates = [path.join(CONFIG_DIR, name)]
    for (const sub of SEARCH_SUBDIRS) candidates.push(path.join(CONFIG_DIR, sub, name))
    for (const p of candidates) {
      if (fs.existsSync(p)) { found = p; break }
    }
    if (found) break
  }
  const defaults = {
    enabled: true,
    fallbackModel: "anthropic/claude-opus-4-5",
    cooldownMs: 300000,
    logging: false,
    rateLimitPatterns: DEFAULT_RATE_PATTERNS,
    disconnectPatterns: DEFAULT_DISCONNECT_PATTERNS,
    resumeWithSameModel: true,
    maxResumeAttempts: 3,
    continuationPromptTemplate: DEFAULT_CONTINUATION_TEMPLATE,
    maxPartialContentLength: 12000,
    loopEnabled: false,
  }
  if (!found) return { config: defaults, source: null }
  try {
    const raw = JSON.parse(fs.readFileSync(found, "utf-8"))
    return {
      source: found,
      config: {
        enabled: raw.enabled ?? defaults.enabled,
        fallbackModel: raw.fallbackModel ?? defaults.fallbackModel,
        cooldownMs: raw.cooldownMs ?? defaults.cooldownMs,
        logging: raw.logging ?? defaults.logging,
        rateLimitPatterns: raw.rateLimitPatterns ?? raw.patterns ?? defaults.rateLimitPatterns,
        disconnectPatterns: raw.disconnectPatterns ?? defaults.disconnectPatterns,
        resumeWithSameModel: raw.resumeWithSameModel ?? defaults.resumeWithSameModel,
        maxResumeAttempts: raw.maxResumeAttempts ?? defaults.maxResumeAttempts,
        continuationPromptTemplate: raw.continuationPromptTemplate ?? defaults.continuationPromptTemplate,
        maxPartialContentLength: raw.maxPartialContentLength ?? defaults.maxPartialContentLength,
        loopEnabled: raw.loopEnabled ?? false,
      },
    }
  } catch {
    return { config: defaults, source: found }
  }
}

function parseModel(model) {
  if (model && typeof model === "object") {
    return { providerID: model.providerID, modelID: model.modelID ?? model.id }
  }
  const s = String(model ?? "")
  const i = s.indexOf("/")
  if (i === -1) return { providerID: s, modelID: s }
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

function makeLogger(enabled) {
  const write = (level, message, fields) => {
    if (!enabled) return
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
      const tail = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : ""
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] ${message}${tail}\n`)
    } catch {}
  }
  return {
    info: (m, f) => write("INFO", m, f),
    warn: (m, f) => write("WARN", m, f),
    error: (m, f) => write("ERROR", m, f),
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function makeMatchers(ratePatterns, disconnectPatterns) {
  const rate = ratePatterns.map((p) => String(p).toLowerCase())
  const disc = disconnectPatterns.map((p) => new RegExp(`\\b${escapeRegex(String(p))}\\b`, "i"))
  return {
    isRateLimit: (text) => {
      const t = String(text ?? "").toLowerCase()
      return rate.some((p) => p && t.includes(p))
    },
    isDisconnect: (text) => disc.some((re) => re.test(String(text ?? ""))),
  }
}

function truncate(s, n) {
  const t = String(s ?? "")
  return t.length > n ? t.slice(0, n) + "…" : t
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Pull the best-effort full error text out of a v2 event. Mirrors the proven
// reading order used by free-model-rotator: properties.error on
// session.execution.failed / session.retry.scheduled / session.error.
function eventText(event) {
  const props = event?.properties ?? {}
  const raw = props.error ?? props.info?.error ?? props
  if (typeof raw === "string") return raw
  const parts = [raw?.name, raw?.message, raw?.data?.message, raw?.error?.message].filter(Boolean)
  let text = parts.join(" ")
  if (!text) {
    try { text = JSON.stringify(raw) ?? "" } catch { text = String(raw ?? "") }
  }
  return text
}

function eventSessionID(event) {
  const props = event?.properties ?? {}
  const direct = props.sessionID ?? props.info?.sessionID ?? props.session?.id ?? props.info?.session?.id
  if (typeof direct === "string" && direct.startsWith("ses")) return direct
  try {
    const m = JSON.stringify(props).match(/\bses[_A-Za-z0-9]+\b/)
    if (m) return m[0]
  } catch {}
  return undefined
}

// Collect plain text out of a session message, defensively across shapes
// (v2: assistant.content[] / user.text; v1-ish: message.parts[] / info/content).
function collectText(entry) {
  const info = entry?.info ?? entry
  const chunks = []
  if (typeof info?.text === "string") chunks.push(info.text)
  for (const list of [info?.content, entry?.parts, info?.parts]) {
    if (!Array.isArray(list)) continue
    for (const part of list) {
      if (!part) continue
      if (typeof part.text === "string" && (part.type === "text" || part.type === undefined)) {
        chunks.push(part.text)
      }
    }
  }
  return chunks.join("\n").trim()
}

function lastTexts(messages) {
  const out = { lastUser: "", lastAssistant: "" }
  for (const m of messages) {
    const info = m?.info ?? m
    const role = info?.role ?? info?.type
    const text = collectText(m)
    if (!text) continue
    if (role === "user") out.lastUser = text
    else if (role === "assistant") out.lastAssistant = text
  }
  return out
}

function buildContinuation(template, partial, maxLen) {
  let p = partial ?? ""
  if (p.length > maxLen) p = p.slice(-maxLen) // keep the tail so the model can find its place
  if (template.includes("{{partial_content}}")) return template.replace("{{partial_content}}", p)
  return template + "\n\n---BEGIN PARTIAL RESPONSE---\n" + p + "\n---END PARTIAL RESPONSE---"
}

function buildNudge(reason) {
  return DEFAULT_NUDGE.replace("{reason}", truncate(reason, 160))
}

export default {
  id: "opencode-fallback",
  async setup(ctx) {
    const { config, source } = loadConfig()
    const log = makeLogger(config.logging !== false)
    const fallbackModel = parseModel(config.fallbackModel)
    const { isRateLimit, isDisconnect } = makeMatchers(config.rateLimitPatterns, config.disconnectPatterns)

    log.info("PLUGIN STARTUP (v2 port)", {
      configFile: source,
      enabled: config.enabled,
      fallbackModel: `${fallbackModel.providerID}/${fallbackModel.modelID}`,
      cooldownMs: config.cooldownMs,
      resumeWithSameModel: config.resumeWithSameModel,
      maxResumeAttempts: config.maxResumeAttempts,
      rateLimitPatterns: config.rateLimitPatterns.length,
      disconnectPatterns: config.disconnectPatterns.length,
    })
    if (!config.enabled) {
      log.info("Plugin disabled via config")
      return
    }
    if (config.loopEnabled) {
      log.warn("loopEnabled=true is not ported to v2 — loop keys ignored")
    }

    const abort = new AbortController()
    const disposers = []
    const sessions = new Map()

    const getState = (sessionID) => {
      let s = sessions.get(sessionID)
      if (!s) {
        s = { resumeAttempts: 0, resumeActive: false, inFlight: false, fallbackCooldownUntil: 0, lastActionAt: 0 }
        sessions.set(sessionID, s)
      }
      if (sessions.size > 64) {
        const stale = [...sessions.entries()]
          .filter(([, v]) => Date.now() - v.lastActionAt > 3_600_000)
          .map(([k]) => k)
        for (const k of stale) sessions.delete(k)
      }
      return s
    }

    const capturePartial = async (sessionID) => {
      try {
        const res = await ctx.session.context({ sessionID })
        const messages = Array.isArray(res) ? res : (res?.messages ?? res?.data ?? [])
        const { lastAssistant } = lastTexts(messages)
        return lastAssistant || null
      } catch (e) {
        log.info("context fetch failed (non-fatal)", { sessionID, error: truncate(e?.message ?? String(e), 160) })
        return null
      }
    }

    const handleRateLimit = async (sessionID, reason) => {
      const s = getState(sessionID)
      const now = Date.now()
      if (s.inFlight) return log.info("action in flight, skipping", { sessionID })
      if (now < s.fallbackCooldownUntil) {
        return log.info("within fallback cooldown, skipping", { sessionID, remainingMs: s.fallbackCooldownUntil - now })
      }
      if (now - s.lastActionAt < 8000) return log.info("debounced, skipping", { sessionID })
      s.inFlight = true
      s.lastActionAt = now
      try {
        const partial = await capturePartial(sessionID)
        log.info("rate-limit recovery: switching model", {
          sessionID, to: `${fallbackModel.providerID}/${fallbackModel.modelID}`,
        })
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: fallbackModel.providerID, id: fallbackModel.modelID },
        })
        const text = partial
          ? buildContinuation(config.continuationPromptTemplate, partial, config.maxPartialContentLength)
          : buildNudge(reason)
        log.info("rate-limit recovery: sending continuation", { sessionID, usedPartial: !!partial, partialLength: partial?.length ?? 0 })
        await ctx.session.prompt({ sessionID, text })
        s.fallbackCooldownUntil = now + config.cooldownMs
        s.resumeAttempts = 0
        log.info("rate-limit recovery: prompt sent", { sessionID, cooldownMs: config.cooldownMs })
      } catch (e) {
        log.error("rate-limit recovery failed", { sessionID, error: truncate(e?.message ?? String(e), 200) })
      } finally {
        s.inFlight = false
      }
    }

    const handleDisconnect = async (sessionID, reason) => {
      const s = getState(sessionID)
      if (s.resumeActive) return log.info("resume already in progress, skipping", { sessionID })
      if (s.resumeAttempts >= config.maxResumeAttempts) {
        return log.warn("max resume attempts reached, giving up", { sessionID, attempts: s.resumeAttempts })
      }
      if (Date.now() - s.lastActionAt < 8000) return log.info("debounced, skipping", { sessionID })
      s.resumeActive = true
      s.lastActionAt = Date.now()
      try {
        s.resumeAttempts += 1
        const backoffMs = Math.min(2000 * 2 ** (s.resumeAttempts - 1), 30000)
        if (s.resumeAttempts > 1) {
          log.info("backoff before retry", { sessionID, attempt: s.resumeAttempts, backoffMs })
          await sleep(backoffMs)
        }
        const partial = await capturePartial(sessionID)
        let switchedToFallback = false
        if (!(config.resumeWithSameModel && s.resumeAttempts <= 1)) {
          await ctx.session.switchModel({
            sessionID,
            model: { providerID: fallbackModel.providerID, id: fallbackModel.modelID },
          })
          switchedToFallback = true
        }
        const text = partial
          ? buildContinuation(config.continuationPromptTemplate, partial, config.maxPartialContentLength)
          : buildNudge(reason)
        await ctx.session.prompt({ sessionID, text })
        log.info("disconnect recovery prompt sent", {
          sessionID, attempt: s.resumeAttempts, usedPartial: !!partial, switchedToFallback,
        })
      } catch (e) {
        log.error("disconnect recovery failed", { sessionID, error: truncate(e?.message ?? String(e), 200) })
      } finally {
        s.resumeActive = false
      }
    }

    try {
      const off = ctx.session.hook("retry", (event) => {
        try {
          const text = eventText(event)
          if (!text) return
          if (isRateLimit(text) || isDisconnect(text)) {
            const kind = isRateLimit(text) ? "rate-limit" : "disconnect"
            log.info(`retry scheduled (${kind})`, {
              sessionID: event?.sessionID ?? event?.session?.id,
              attempt: event?.attempt,
              message: truncate(text, 200),
            })
          }
        } catch (e) {
          log.error("retry hook error", { error: truncate(e?.message ?? String(e), 160) })
        }
      })
      if (typeof off === "function") disposers.push(off)
    } catch (e) {
      log.warn("retry hook unavailable", { error: truncate(e?.message ?? String(e), 160) })
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            const type = event?.type
            if (type === "session.idle") {
              const sid = eventSessionID(event)
              if (sid) {
                const s = sessions.get(sid)
                if (s) s.resumeAttempts = 0
              }
              continue
            }
            if (type !== "session.execution.failed" && type !== "session.error") continue
            const text = eventText(event)
            const sessionID = eventSessionID(event)
            if (!sessionID) {
              log.warn("failure event without sessionID", { type, message: truncate(text, 160) })
              continue
            }
            const rate = isRateLimit(text)
            const disconnect = !rate && isDisconnect(text)
            if (!rate && !disconnect) continue
            log.info(`terminal failure (${rate ? "rate-limit" : "disconnect"})`, {
              sessionID, message: truncate(text, 240),
            })
            if (rate) await handleRateLimit(sessionID, text)
            else await handleDisconnect(sessionID, text)
          } catch (e) {
            log.error("event handler error", { error: truncate(e?.message ?? String(e), 200) })
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) log.info(`event subscription ended: ${truncate(e?.message ?? String(e), 160)}`)
      }
    })()

    return () => {
      abort.abort()
      for (const fn of disposers) {
        try { fn() } catch {}
      }
    }
  },
}
