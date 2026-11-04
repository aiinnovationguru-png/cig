import { useEffect, useState } from "react";
import { api, type EmbeddingStatus, type Settings } from "../api";
import { Field, Spinner } from "../components/ui";

export default function SettingsPage({
  notify,
}: {
  notify: (message: string, tone?: "info" | "error") => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getSettings(), api.embeddingStatus()])
      .then(([config, embedding]) => {
        setSettings(config);
        setStatus(embedding);
      })
      .catch((error) => notify(String(error), "error"))
      .finally(() => setLoading(false));
  }, [notify]);

  const patch = (values: Partial<Settings>) =>
    setSettings((previous) => (previous ? { ...previous, ...values } : previous));

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      notify("Impostazioni salvate");
      setStatus(await api.embeddingStatus());
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const testEmail = async () => {
    setTesting(true);
    try {
      await api.sendTestEmail();
      notify(`Email di prova inviata a ${settings?.alertRecipient}`);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setTesting(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="p-7">
        <Spinner label="Carico le impostazioni…" />
      </div>
    );
  }

  const providerChanged = settings.embeddingProvider !== (status?.provider === "api" ? "api" : "local");
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-white px-6 py-2.5">
        <p className="text-[11.5px] text-muted">
          Motore di ricerca, invio email e orari del digest.
        </p>
        <button className="btn btn-primary px-4 py-1.5 text-[12px]" onClick={save} disabled={saving}>
          {saving ? "Salvo…" : "Salva impostazioni"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl space-y-3">
          <section className="card px-4 py-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-[13px] font-semibold text-heading">Ricerca semantica</h2>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Il modello locale gira offline sul tuo computer dopo il primo download (~120 MB).
                </p>
              </div>
              <div className="flex items-center gap-2 text-[10.5px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status?.ready ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                <span className="text-slate-500">
                  {status ? (status.ready ? "pronto" : "non disponibile") : "verifico…"}
                </span>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Provider">
                <select
                  className="input"
                  value={settings.embeddingProvider}
                  onChange={(event) =>
                    patch({ embeddingProvider: event.target.value as "local" | "api" })
                  }
                >
                  <option value="local">Locale (consigliato)</option>
                  <option value="api">API OpenAI-compatibile</option>
                </select>
              </Field>
              <Field label="Modello" hint={status ? `${status.dims} dimensioni · ${status.model}` : undefined}>
                <input
                  className="input"
                  value={
                    settings.embeddingProvider === "local"
                      ? "multilingual-e5-small"
                      : settings.apiModel
                  }
                  disabled={settings.embeddingProvider === "local"}
                  onChange={(event) => patch({ apiModel: event.target.value })}
                />
              </Field>
            </div>

            {settings.embeddingProvider === "api" && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Base URL">
                  <input
                    className="input"
                    value={settings.apiBaseUrl}
                    onChange={(event) => patch({ apiBaseUrl: event.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </Field>
                <Field label="API key">
                  <input
                    type="password"
                    className="input"
                    value={settings.apiKey}
                    onChange={(event) => patch({ apiKey: event.target.value })}
                    placeholder="sk-…"
                  />
                </Field>
                <div className="col-span-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-900">
                  Il modello deve produrre vettori a 384 dimensioni. Cambiando provider gli
                  embedding esistenti vengono azzerati e vanno ricalcolati dalla pagina Dati.
                </div>
              </div>
            )}

            {providerChanged && (
              <div className="mt-2 text-[10.5px] text-amber-800">
                Se salvi, gli embedding esistenti saranno eliminati.
              </div>
            )}

            {status?.error && (
              <div className="mt-2 rounded border border-rose-500/25 bg-rose-500/5 px-2.5 py-1.5 text-[10.5px] text-rose-200/80">
                {status.error}
              </div>
            )}
          </section>

          <section className="card px-4 py-4">
            <h2 className="text-[13px] font-semibold text-heading">Preferenze di ricerca</h2>
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[11.5px] leading-relaxed text-slate-600">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-cyan-800"
                checked={settings.hideExpiredDefault}
                onChange={(event) => patch({ hideExpiredDefault: event.target.checked })}
              />
              <span>
                <span className="font-semibold text-heading">Nascondi le gare scadute</span> quando
                apri la ricerca. Puoi sempre riattivarle togliendo la spunta a «nascondi scaduti»
                nella barra laterale.
              </span>
            </label>
          </section>

          <section className="card px-4 py-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-[13px] font-semibold text-heading">Email e digest</h2>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Serve un account SMTP (Gmail con password per app, Brevo, Mailgun, il tuo provider).
                </p>
              </div>
              <button
                className="btn px-2.5 py-1 text-[11px]"
                onClick={testEmail}
                disabled={testing || !settings.smtpHost}
              >
                {testing ? "Invio…" : "Invia prova"}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Server SMTP">
                <input
                  className="input"
                  value={settings.smtpHost}
                  onChange={(event) => patch({ smtpHost: event.target.value })}
                  placeholder="smtp.example.com"
                />
              </Field>
              <Field label="Porta">
                <input
                  type="number"
                  className="input"
                  value={settings.smtpPort}
                  onChange={(event) => patch({ smtpPort: Number(event.target.value) })}
                />
              </Field>
              <Field label="Sicurezza">
                <select
                  className="input"
                  value={settings.smtpSecurity}
                  onChange={(event) =>
                    patch({ smtpSecurity: event.target.value as Settings["smtpSecurity"] })
                  }
                >
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">TLS (465)</option>
                  <option value="none">Nessuna (locale)</option>
                </select>
              </Field>
              <Field label="Utente">
                <input
                  className="input"
                  value={settings.smtpUser}
                  onChange={(event) => patch({ smtpUser: event.target.value })}
                  placeholder="utente@example.com"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  className="input"
                  value={settings.smtpPassword}
                  onChange={(event) => patch({ smtpPassword: event.target.value })}
                />
              </Field>
              <Field label="Mittente" hint="deve essere autorizzato dal provider">
                <input
                  className="input"
                  value={settings.smtpFrom}
                  onChange={(event) => patch({ smtpFrom: event.target.value })}
                  placeholder="CIG <alert@example.com>"
                />
              </Field>
              <div className="col-span-2">
                <Field label="Destinatario">
                  <input
                    className="input"
                    value={settings.alertRecipient}
                    onChange={(event) => patch({ alertRecipient: event.target.value })}
                    placeholder="tu@example.com"
                  />
                </Field>
              </div>
              <Field label="Ora del digest">
                <select
                  className="input"
                  value={settings.alertHour}
                  onChange={(event) => patch({ alertHour: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Fuso orario"
                hint={settings.digestTimezone === "local" ? `sistema: ${localZone}` : "UTC"}
              >
                <select
                  className="input"
                  value={settings.digestTimezone}
                  onChange={(event) =>
                    patch({ digestTimezone: event.target.value as Settings["digestTimezone"] })
                  }
                >
                  <option value="local">Locale (sistema)</option>
                  <option value="utc">UTC</option>
                </select>
              </Field>
              <Field label="Finestra (giorni)" hint="quanto storico considerare">
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="input"
                  value={settings.digestDays}
                  onChange={(event) => patch({ digestDays: Number(event.target.value) })}
                />
              </Field>
              <Field
                label="Massimo gare per digest"
                hint="limite complessivo, ricerche ed enti insieme"
              >
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="input"
                  value={settings.digestMaxNotices}
                  onChange={(event) => patch({ digestMaxNotices: Number(event.target.value) })}
                />
              </Field>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">
              Il digest unisce tutte le ricerche attive e gli enti seguiti in una sola email. Le gare
              duplicate vengono mostrate una sola volta e il totale non supera il limite indicato.
            </p>
          </section>

          <section className="card px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            I dati restano su questo computer: SQLite in{" "}
            <span className="font-mono text-slate-600">%APPDATA%\it.cig.intelligence\cig.db</span>. Le
            esportazioni Excel finiscono nella sottocartella{" "}
            <span className="font-mono text-slate-600">export</span>. Fonti dati: TED (Tenders
            Electronic Daily, Commissione europea) e ANAC/BDNCP (dati aperti nazionali).
          </section>
        </div>
      </div>
    </div>
  );
}
