import { useCallback, useEffect, useState } from "react"
import { Check, Copy, ExternalLink, LoaderCircle, Sparkles } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { useConfirm } from "@/components/confirm-dialog"
import { MediaSettings } from "@/components/media-settings"
import { OptionSelect } from "@/components/option-select"
import { api, type AiLogin, type AiStatus } from "@/lib/api"

function DeviceCode({ login }: { login: Extract<AiLogin, { type: "chatgptDeviceCode" }> }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard?.writeText(login.userCode).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <ol className="device-steps">
      <li>
        <span>Copy the code</span>
        <button className="device-code" onClick={() => void copy()} type="button">
          <strong>{login.userCode}</strong>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </li>
      <li>
        <span>Open the OpenAI page, sign in and enter it</span>
        <Button render={<a href={login.verificationUrl} rel="noreferrer" target="_blank" />} size="sm" variant="outline"><ExternalLink aria-hidden="true" data-icon="inline-start" />Open sign-in page</Button>
      </li>
    </ol>
  )
}

const EFFORT_OPTIONS: Array<{ value: "low" | "medium"; label: string }> = [
  { value: "medium", label: "High (recommended)" },
  { value: "low", label: "Standard" },
]

export function SettingsView() {
  const confirm = useConfirm()
  const [status, setStatus] = useState<AiStatus>()
  const [error, setError] = useState<string>()
  const [login, setLogin] = useState<AiLogin>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.aiStatus()
      setStatus(next)
      if (next.connected) setLogin(undefined)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of server state
    void refresh()
  }, [refresh])

  // While a sign-in is in progress, poll until Codex reports the account.
  useEffect(() => {
    if (!login) return
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [login, refresh])

  const connect = async () => {
    setBusy(true)
    try {
      const next = await api.aiLogin()
      setLogin(next)
      if (next.type === "chatgpt") window.open(next.authUrl, "_blank", "noopener")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!(await confirm({ title: "Disconnect ChatGPT?", description: "Verba stops using your ChatGPT subscription for text enhancement. Your Codex login on this computer is not affected.", confirmLabel: "Disconnect", destructive: true }))) return
    await api.aiLogout()
    await refresh()
  }

  const changeSettings = async (settings: { model?: string; effort?: "low" | "medium" }) => {
    setStatus((current) => current && { ...current, ...settings })
    await api.aiSettings(settings)
  }

  return (
    <div className="library-view max-w-3xl">
      <div className="section-kicker">Verba</div>
      <h1 className="mt-1 text-[clamp(2rem,4vw,3rem)] leading-none font-[510] tracking-[-0.045em]">Settings</h1>

      <section className="settings-card" aria-labelledby="ai-heading">
        <div className="flex items-start gap-3">
          <span className="settings-card-icon"><Sparkles aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-[510] tracking-[-0.02em]" id="ai-heading">AI text enhancement</h2>
            <p className="mt-1 text-[13px] text-pretty text-muted-foreground">Before narration, an LLM rewrites each chapter into its spoken form: expands numbers and abbreviations, places Russian stress marks and removes footnotes, copyright notices and other text nobody reads aloud. Runs through Codex on your ChatGPT subscription.</p>
          </div>
        </div>

        <div className="settings-card-body">
          {!status && !error && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />Checking Codex…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {status && !status.available && <p className="text-xs text-pretty text-muted-foreground">Codex isn’t available on the server: {status.error}. Install it with <code>npm i -g @openai/codex</code> and restart Verba.</p>}

          {status?.available && (
            <>
              <div className="settings-line">
                <div className="min-w-0">
                  <div className="text-[13px] font-[510]">ChatGPT account</div>
                  <div className="truncate text-xs text-muted-foreground">{status.connected ? `${status.email ?? "Connected"}${status.plan ? ` · ${status.plan}` : ""}` : "Not connected"}</div>
                </div>
                {status.connected ? (
                  <Button onClick={() => void disconnect()} size="sm" variant="outline">Disconnect</Button>
                ) : (
                  <Button disabled={busy} onClick={() => void connect()} size="sm">{busy && <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" />}Connect ChatGPT</Button>
                )}
              </div>

              {login && !status.connected && (
                <div className="settings-line block">
                  {login.type === "chatgptDeviceCode" ? <DeviceCode login={login} /> : <p className="text-xs text-pretty text-muted-foreground">Finish signing in in the tab that just opened. <a className="text-foreground underline underline-offset-2" href={login.authUrl} rel="noreferrer" target="_blank">Open it again</a></p>}
                  <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />Waiting for confirmation…</p>
                </div>
              )}

              {status.connected && (
                <div className="settings-line">
                  <div className="min-w-0">
                    <div className="text-[13px] font-[510]">Model</div>
                    <div className="text-xs text-muted-foreground">GPT-6-Sol places Russian stress marks most accurately; smaller models miss or misplace many.</div>
                  </div>
                  <OptionSelect variant="settings" label="Model" onChange={(model) => void changeSettings({ model })} options={status.models.map((model) => ({ value: model.id, label: model.id === "gpt-6-sol" ? `${model.name} (recommended)` : model.name }))} value={status.model} />
                </div>
              )}

              {status.connected && (
                <div className="settings-line">
                  <div className="min-w-0">
                    <div className="text-[13px] font-[510]">Stress accuracy</div>
                    <div className="text-xs text-muted-foreground">High lets the model think longer and catches most wrong stresses; about 1.6× slower.</div>
                  </div>
                  <OptionSelect variant="settings" label="Stress accuracy" onChange={(effort) => void changeSettings({ effort })} options={EFFORT_OPTIONS} value={status.effort} />
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <MediaSettings />
    </div>
  )
}
