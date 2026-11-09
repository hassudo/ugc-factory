const fs = await import("node:fs")
const path = await import("node:path")
const os = await import("node:os")

const DEFAULT_MODEL = "big-pickle"
const AUTHOR = "hassan30k"
const PROJECT = "ugc-factory"

const statePath = path.join(os.homedir(), ".cache", "opencode", "agent-capture-state.json")

function loadState() {
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, "utf8")
      const data = JSON.parse(raw)
      if (data && typeof data === "object") return data
    }
  } catch (e) {}
  return {}
}

function saveState(state) {
  try {
    if (!fs.existsSync(path.dirname(statePath))) fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(state, null, 0))
  } catch (e) {}
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "")
}

function timestamp() {
  return new Date().toISOString()
}

function dayStamp(iso) {
  return (iso || timestamp()).slice(0, 10)
}

function textOfParts(parts) {
  if (!Array.isArray(parts)) return null
  const texts = parts
    .filter((p) => (p.type || "").toLowerCase() === "text")
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
  if (texts.length === 0) return null
  return texts.join("\n")
}

export const CapturePlugin = async ({ client, directory }) => {
  const logDir = path.join(directory, ".agent-logs")

  const mainSessions = new Set()
  const checkedSessions = new Set()
  const state = loadState()

  const sessions = new Map()

  function markLogged(sid, key) {
    if (!state[sid]) state[sid] = { logged: [] }
    if (!state[sid].logged.includes(key)) state[sid].logged.push(key)
  }

  function isLogged(sid, key) {
    return !!(state[sid] && state[sid].logged && state[sid].logged.includes(key))
  }

  function header(s) {
    return `---\nsession_id: ${s.sessionID}\ndate: ${dayStamp()}\nauthor: ${AUTHOR}\nmodel: ${DEFAULT_MODEL}\ntool: opencode\nproject: ${PROJECT}\ntotal_exchanges: ${s.exchangeNum}\nfirst_prompt_time: ${s.firstPromptTime ?? ""}\nlast_prompt_time: ${s.lastPromptTime ?? ""}\n---\n\n# Session Log - ${dayStamp()}\n\nSession: \`${s.sessionID}\` | Project: \`${PROJECT}\` | Author: \`${AUTHOR}\`\n\n---\n`
  }

  function findExistingFile(sid) {
    try {
      if (!fs.existsSync(logDir)) return null
      for (const n of fs.readdirSync(logDir)) {
        if (!n.endsWith(".md")) continue
        const p = path.join(logDir, n)
        const raw = fs.readFileSync(p, "utf8")
        const m = raw.match(/^session_id:\s*(\S+)/m)
        if (m && m[1] === sid) return { file: p, raw }
      }
    } catch (e) {}
    return null
  }

  function sessionState(sid) {
    let s = sessions.get(sid)
    if (s) return s
    const prior = state[sid] || {}
    s = {
      sessionID: sid,
      file: prior.file || null,
      entries: prior.entries || "",
      exchangeNum: prior.exchangeNum || 0,
      currentPromptNum: prior.currentPromptNum || 0,
      firstPromptTime: prior.firstPromptTime || null,
      lastPromptTime: prior.lastPromptTime || null,
      pending: Array.isArray(prior.pending) ? prior.pending.slice() : [],
    }
    if (!s.file) {
      const existing = findExistingFile(sid)
      if (existing) {
        s.file = existing.file
        const ex = existing.raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
        if (ex) {
          for (const line of ex[1].split("\n")) {
            if (line.startsWith("total_exchanges:")) s.exchangeNum = parseInt((line.split(":")[1] || "0").trim(), 10) || 0
            if (line.startsWith("first_prompt_time:")) s.firstPromptTime = line.split(":")[1].trim()
            if (line.startsWith("last_prompt_time:")) s.lastPromptTime = line.split(":")[1].trim()
          }
          s.currentPromptNum = s.exchangeNum
          const si = ex[2].indexOf("[LOG_ENTRY")
          s.entries = si >= 0 ? ex[2].slice(si) : ""
        }
      }
    }
    sessions.set(sid, s)
    return s
  }

  function persist(s) {
    if (!state[s.sessionID]) state[s.sessionID] = {}
    const st = state[s.sessionID]
    st.file = s.file
    st.entries = s.entries
    st.exchangeNum = s.exchangeNum
    st.currentPromptNum = s.currentPromptNum
    st.firstPromptTime = s.firstPromptTime
    st.lastPromptTime = s.lastPromptTime
    st.pending = s.pending.slice()
    if (!Array.isArray(st.logged)) st.logged = []
    saveState(state)
  }

  async function isMainSession(sid) {
    if (mainSessions.has(sid)) return true
    if (checkedSessions.has(sid)) return false
    checkedSessions.add(sid)
    try {
      const res = await client.session.get({ path: { id: sid } })
      const info = (res && (res.data || res)) || {}
      const parentID = info.parentID
      if (parentID === undefined || parentID === null || parentID === "") {
        mainSessions.add(sid)
        return true
      }
    } catch (e) {}
    return false
  }

  function writeFile(s) {
    if (!s.file) return
    try {
      fs.writeFileSync(s.file, header(s) + s.entries)
    } catch (e) {}
  }

  function append(s, type, num, text, model, tsMs) {
    if (!s.file) {
      try {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
        s.file = path.join(logDir, `${stamp}_${slug(s.sessionID).slice(0, 20)}.md`)
      } catch (e) {
        return
      }
    }
    const ts = tsMs ? new Date(tsMs).toISOString() : timestamp()
    const m = model && model !== "unknown" ? model : DEFAULT_MODEL
    s.entries += `\n[LOG_ENTRY type=${type} num=${num} session=${s.sessionID}]\ntimestamp: ${ts}\nmodel: ${m}\n\n${String(text).trimEnd()}\n\n`
    if (type === "PROMPT") {
      s.firstPromptTime = s.firstPromptTime ?? ts
      s.lastPromptTime = ts
    }
    writeFile(s)
    persist(s)
  }

  async function captureTurn(sid) {
    const s = sessionState(sid)
    let dirty = false
    const res = await client.session.messages({ path: { id: sid } })
    const messages = res && (res.data || res)
    if (!Array.isArray(messages)) return

    for (const m of messages) {
      const info = (m && (m.info || m.message || m)) || {}
      const parts = (m && m.parts) || []
      const role = info.role
      const mid = info.id
      if (!mid || !role) continue
      const key = `${sid}:${mid}`
      if (isLogged(sid, key)) continue

      if (role === "user") {
        const text = textOfParts(parts)
        if (text === null) continue
        markLogged(sid, key)
        s.exchangeNum += 1
        s.currentPromptNum = s.exchangeNum
        s.pending.push(s.exchangeNum)
        append(s, "PROMPT", s.exchangeNum, text, info.modelID, info.time && info.time.created)
        dirty = true
      } else if (role === "assistant") {
        if (!info.time || info.time.completed === undefined || info.time.completed === null) continue
        const text = textOfParts(parts)
        if (text === null) continue
        markLogged(sid, key)
        if (s.pending.length > 0) {
          const num = s.pending.shift()
          append(s, "RESPONSE", num, text, info.modelID, info.time.completed)
        } else if (s.exchangeNum >= 1) {
          append(s, "RESPONSE", s.exchangeNum, text, info.modelID, info.time.completed)
        }
        dirty = true
      }
    }

    if (!dirty) persist(s)
  }

  return {
    event: async ({ event }) => {
      try {
        const t = event.type
        const p = event.properties || {}

        if (t === "session.created") {
          const info = p.info || {}
          if (!info.parentID) mainSessions.add(p.sessionID)
          return
        }

        if (t === "session.idle") {
          if (p.sessionID && (mainSessions.has(p.sessionID) || (await isMainSession(p.sessionID)))) {
            await captureTurn(p.sessionID)
          }
          return
        }

        if (t === "message.updated") {
          const info = p.info || {}
          if (!info.id || !p.sessionID) return
          if (!mainSessions.has(p.sessionID)) {
            if (!(await isMainSession(p.sessionID))) return
          }
          if (info.role === "assistant" && info.time && info.time.completed) {
            await captureTurn(p.sessionID)
          }
        }
      } catch (e) {
        try {
          console.error("[capture] error:", e instanceof Error ? e.message : String(e))
        } catch (x) {}
      }
    },
  }
}