// Talks to the official Codex app-server (JSON-RPC over stdio) so text cleanup runs on the
// user's ChatGPT subscription. Tokens stay inside Codex's own credential store; we never read them.
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const BUNDLED_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
const REQUEST_TIMEOUT = 60_000
const TURN_TIMEOUT = 240_000

// Pure text transformation: no tools, MCPs, plugins, web or repository instructions.
const CODEX_CONFIG: Record<string, unknown> = {
  web_search: "disabled",
  project_doc_max_bytes: 0,
  "features.shell_tool": false,
  "features.apps": false,
  "features.plugins": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "features.image_generation": false,
  "features.view_image": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "tools.update_plan.enabled": false,
}

type RpcMessage = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

export type CodexStatus = { available: boolean; connected: boolean; email?: string; plan?: string; models: Array<{ id: string; name: string }>; loginPending: boolean; error?: string }
export type CodexLogin = { type: "chatgpt"; authUrl: string } | { type: "chatgptDeviceCode"; verificationUrl: string; userCode: string }

class CodexClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: Timer }>()
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly process: ReturnType<typeof Bun.spawn>
  closed = false

  constructor(binary: string, home: string) {
    const cwd = path.join(home, "workspace")
    const overrides = Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])
    this.process = Bun.spawn([binary, "app-server", ...overrides], {
      cwd,
      env: { HOME: homedir(), CODEX_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    void this.read()
    void this.process.exited.then(() => this.fail(new Error("Codex app-server exited")))
  }

  private async read() {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of this.process.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: RpcMessage
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = message.id !== undefined && !message.method ? this.pending.get(message.id) : undefined
        if (waiter) {
          this.pending.delete(message.id!)
          clearTimeout(waiter.timer)
          if (message.error) waiter.reject(new Error(`Codex: ${message.error.message.slice(0, 500)}`))
          else waiter.resolve(message.result)
        } else if (message.id !== undefined && message.method) {
          // Server-initiated request (approvals etc.): this client never grants anything.
          this.write({ id: message.id, result: { decision: "decline" } })
        } else {
          this.listeners.forEach((listener) => listener(message))
        }
      }
    }
  }

  private write(message: unknown) {
    const stdin = this.process.stdin as import("bun").FileSink
    stdin.write(JSON.stringify(message) + "\n")
    stdin.flush()
  }

  private fail(error: Error) {
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.listeners.forEach((listener) => listener({ method: "verba/closed" }))
  }

  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is not running"))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string) {
    this.write({ method })
  }

  listen(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.process.kill()
  }
}

export class CodexService {
  private client?: Promise<CodexClient>
  private loginPending = false
  private readonly home: string

  constructor(dataDir: string) {
    this.home = process.env.VERBA_CODEX_HOME ?? path.join(dataDir, "codex")
  }

  private async binary() {
    const configured = process.env.VERBA_CODEX_BINARY
    if (configured) return configured
    if (await Bun.file(BUNDLED_BINARY).exists()) return BUNDLED_BINARY
    return Bun.which("codex") ?? undefined
  }

  private async start() {
    const binary = await this.binary()
    if (!binary) throw new Error("Codex CLI is not installed (npm i -g @openai/codex)")
    await mkdir(path.join(this.home, "workspace"), { recursive: true, mode: 0o700 })
    const auth = path.join(this.home, "auth.json")
    const personal = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json")
    const optedOut = await Bun.file(path.join(this.home, "signed-out")).exists()
    // Reuse an existing Codex login on this machine by linking (not copying or reading) its credential file.
    if (!optedOut && !(await lstat(auth).catch(() => null)) && (await Bun.file(personal).exists())) {
      await symlink(personal, auth).catch(() => undefined)
    }
    const client = new CodexClient(binary, this.home)
    await client.request("initialize", { clientInfo: { name: "verba", title: "Verba", version: "0.1.0" } })
    client.notify("initialized")
    return client
  }

  private async get() {
    const current = this.client && (await this.client.catch(() => undefined))
    if (!current || current.closed) {
      this.client = this.start()
      this.client.catch(() => (this.client = undefined))
    }
    return this.client!
  }

  async status(): Promise<CodexStatus> {
    try {
      const client = await this.get()
      const [account, models] = await Promise.all([client.request("account/read", { refreshToken: false }), client.request("model/list", {})])
      const connected = account.account?.type === "chatgpt"
      return {
        available: true,
        connected,
        email: account.account?.email,
        plan: account.account?.planType,
        loginPending: this.loginPending,
        models: (models.data ?? []).filter((model: any) => !model.hidden).map((model: any) => ({ id: model.model, name: model.displayName ?? model.model })),
      }
    } catch (error) {
      return { available: false, connected: false, models: [], loginPending: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Browser OAuth for a local checkout; device code (URL + one-time code) on a headless Linux server. */
  async login(): Promise<CodexLogin> {
    const client = await this.get()
    const mode = process.env.VERBA_CODEX_LOGIN ?? (process.platform === "darwin" ? "browser" : "device")
    await Bun.file(path.join(this.home, "signed-out")).delete().catch(() => undefined)
    this.loginPending = true
    const stop = client.listen((message) => {
      if (message.method === "account/login/completed" || message.method === "verba/closed") {
        this.loginPending = false
        stop()
      }
    })
    setTimeout(() => {
      this.loginPending = false
      stop()
    }, 15 * 60_000)
    try {
      return await client.request("account/login/start", { type: mode === "device" ? "chatgptDeviceCode" : "chatgpt" })
    } catch (error) {
      this.loginPending = false
      stop()
      throw error
    }
  }

  async logout() {
    const client = await this.get()
    await writeFile(path.join(this.home, "signed-out"), "")
    const auth = path.join(this.home, "auth.json")
    // Unlink only our link: the personal ~/.codex login stays signed in.
    if ((await lstat(auth).catch(() => null))?.isSymbolicLink()) await Bun.file(auth).delete()
    await client.request("account/logout", {}).catch(() => undefined)
  }

  /** Runs one stateless turn and returns the model's final message, constrained to `schema`. */
  async complete(model: string, instructions: string, input: string, schema: unknown, effort = "low"): Promise<string> {
    const client = await this.get()
    const { thread } = await client.request("thread/start", {
      model,
      baseInstructions: instructions,
      developerInstructions: "",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: CODEX_CONFIG,
    })
    return new Promise<string>((resolve, reject) => {
      let answer = ""
      let turnId: string | undefined
      const timer = setTimeout(() => finish(new Error("Codex turn timed out")), TURN_TIMEOUT)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        stop()
        void client.request("thread/archive", { threadId: thread.id }).catch(() => undefined)
        if (error) reject(error)
        else resolve(answer)
      }
      const stop = client.listen((message) => {
        const params = message.params
        if (message.method === "verba/closed") return finish(new Error("Codex app-server stopped"))
        if (params?.threadId !== thread.id) return
        if (message.method === "item/completed" && params.item?.type === "agentMessage") answer = params.item.text
        if (message.method === "turn/completed" && (!turnId || params.turn?.id === turnId)) {
          const turn = params.turn
          if (turn.status === "completed") finish()
          else finish(new Error(turn.error?.message ? `Model error: ${String(turn.error.message).slice(0, 300)}` : `Turn ${turn.status}`))
        }
      })
      client
        .request("turn/start", { threadId: thread.id, input: [{ type: "text", text: input }], effort, outputSchema: schema })
        .then((result) => (turnId = result.turn?.id))
        .catch((error) => finish(error))
    })
  }
}
