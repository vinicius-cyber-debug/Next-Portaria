'use client';

import { Check, LoaderCircle, Plug, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { request } from '../lib/http-client';
import { Button, FormField, LoadingState, StatusBadge } from './ui';

type Connection = {
  supported?: boolean;
  editable?: boolean;
  configured: boolean;
  origin?: string;
  username?: string;
  sourceId?: string;
  fingerprint256?: string;
  certificateExpiresAt?: string;
  certificateValid?: boolean;
  passwordConfigured?: boolean;
  version: string;
};
type Result = Partial<Connection> & {
  ok?: boolean;
  status?: string;
  checkedAt?: string;
  connection?: { status?: string; checkedAt?: string };
  retryAfterSeconds?: number;
  config?: Connection;
  error?: { code?: string; message?: string; retryAfterSeconds?: number };
};
type CheckResult = { connected: boolean; checkedAt: string };

const endpoint = '/api/admin/controlid';
const defaultSource = 'idsecure-principal';
const maxCertificateSize = 64 * 1024;
function displayDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Não informado';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Manaus',
  }).format(new Date(value));
}
async function readResult(response: Response): Promise<Result> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { error: { message: 'Não foi possível consultar a configuração da central.' } };
  return value as Result;
}

export function ControlIdSettings({
  disabled = false,
  onSaved,
}: {
  disabled?: boolean;
  onSaved?: () => Promise<void>;
}) {
  const [configuration, setConfiguration] = useState<Connection | null>(null),
    [origin, setOrigin] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [certificatePem, setCertificatePem] = useState(''),
    [sourceId, setSourceId] = useState(defaultSource),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<'test' | 'save' | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [retryAfter, setRetryAfter] = useState(0),
    [check, setCheck] = useState<CheckResult | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const applyConfiguration = useCallback((value: Connection) => {
    setConfiguration(value);
    setOrigin(value.origin ?? '');
    setUsername(value.username ?? '');
    setSourceId(value.sourceId || defaultSource);
    setPassword('');
    setCertificatePem('');
    setCheck(null);
  }, []);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const response = await request(endpoint, { cache: 'no-store', signal });
        const value = await readResult(response);
        if (signal?.aborted) return;
        if (!response.ok)
          throw Error(value.error?.message || 'Não foi possível carregar a conexão.');
        applyConfiguration(value.config ?? (value as Connection));
      } catch (reason) {
        if (!signal?.aborted)
          setError(
            reason instanceof Error ? reason.message : 'Não foi possível carregar a conexão.',
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applyConfiguration],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void reload(controller.signal), 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [reload]);
  useEffect(() => {
    if (retryAfter < 1) return;
    const timer = setTimeout(() => setRetryAfter((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  function changed() {
    setCheck(null);
    setMessage('');
    setError('');
  }
  async function chooseCertificate(file: File | undefined) {
    if (!file) return;
    changed();
    if (file.size > maxCertificateSize) {
      setError('O certificado PEM deve ter até 64 KiB.');
      return;
    }
    try {
      const text = await file.text();
      if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text))
        throw Error('Selecione somente o certificado público, sem chave privada.');
      if (!text.includes('-----BEGIN CERTIFICATE-----'))
        throw Error('Use um certificado público X.509 no formato PEM.');
      setCertificatePem(text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível ler o certificado.');
    }
  }
  async function submit(action: 'test' | 'save') {
    if (
      busy ||
      retryAfter > 0 ||
      disabled ||
      configuration?.editable === false ||
      !configuration?.version ||
      !form.current?.reportValidity()
    )
      return;
    setError('');
    setMessage('');
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(certificatePem)) {
      setError('Informe somente o certificado público, sem chave privada.');
      return;
    }
    setBusy(action);
    try {
      const response = await request(action === 'test' ? endpoint + '/test' : endpoint, {
        method: action === 'test' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: origin.trim(),
          username: username.trim(),
          sourceId: sourceId.trim(),
          version: configuration.version,
          ...(password ? { password } : {}),
          ...(certificatePem.trim() ? { certificatePem: certificatePem.trim() } : {}),
        }),
      });
      const value = await readResult(response);
      if (response.status === 429)
        setRetryAfter(
          Math.min(
            60,
            Math.max(
              1,
              Number(
                value.retryAfterSeconds ??
                  value.error?.retryAfterSeconds ??
                  response.headers.get('Retry-After'),
              ) || 3,
            ),
          ),
        );
      if (value.error?.code === 'CONTROLID_CONFIG_CHANGED') {
        await reload();
        throw Error(
          'A configuração mudou em outra sessão. Os dados atuais foram recarregados; revise antes de salvar.',
        );
      }
      if (!response.ok) {
        setCheck({ connected: false, checkedAt: new Date().toISOString() });
        throw Error(value.error?.message || 'Não foi possível validar a conexão com a central.');
      }
      if (action === 'save') {
        if (value.config?.version) applyConfiguration(value.config);
        else if (value.version) applyConfiguration(value as Connection);
        else await reload();
        setPassword('');
        setCertificatePem('');
        setMessage('Conexão validada e salva. A senha permanece protegida.');
        // Refresh the operational revision without turning a saved connection into a form error.
        if (onSaved) await onSaved().catch(() => undefined);
      } else setMessage('A central respondeu ao teste de conexão.');
      setCheck({
        connected: true,
        checkedAt: value.connection?.checkedAt || value.checkedAt || new Date().toISOString(),
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Não foi possível concluir a configuração.',
      );
    } finally {
      setBusy(null);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit('save');
  }
  const locked = disabled || configuration?.editable === false || Boolean(busy) || loading;
  const credentialsChanged =
    configuration?.configured &&
    (origin.trim().replace(/\/$/, '') !== configuration.origin ||
      username.trim() !== configuration.username);
  const needsCertificate =
    !configuration?.fingerprint256 || configuration.certificateValid === false;
  return (
    <section className="controlid-panel" aria-labelledby="controlid-settings-title">
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title" id="controlid-settings-title">
              Conexão Control iD / iDSecure
            </h2>
          </div>
          <StatusBadge value={check ? (check.connected ? 'active' : 'denied') : 'pending'}>
            {check
              ? check.connected
                ? 'Conexão validada'
                : 'Último teste falhou'
              : configuration?.configured
                ? 'Configuração salva'
                : 'Não configurada'}
          </StatusBadge>
        </div>
        <div className="card-body controlid-body">
          <p className="controlid-scope">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Conexão de leitura para consulta de eventos da central.</span>
          </p>
          {loading && !configuration ? (
            <LoadingState>Consultando configuração…</LoadingState>
          ) : null}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="notice success" role="status">
              <Check size={18} aria-hidden="true" />
              {message}
            </div>
          )}
          {!loading && !configuration && (
            <Button
              disabled={Boolean(busy)}
              onClick={() => {
                setError('');
                void reload();
              }}
            >
              <RefreshCw size={16} />
              Tentar novamente
            </Button>
          )}
          {configuration?.supported === false ? (
            <p className="field-hint">
              A configuração da central está disponível na instalação local PostgreSQL.
            </p>
          ) : (
            configuration && (
              <form ref={form} onSubmit={save} className="controlid-form">
                {configuration.editable === false && (
                  <p className="notice info">
                    A integração de saída está ativa. Gerencie a conexão pelo servidor.
                  </p>
                )}
                <div className="form-grid">
                  <FormField
                    label="Endereço HTTPS da central"
                    hint="Inclua o IP da rede interna e a porta da central."
                  >
                    <input
                      className="input"
                      type="url"
                      required
                      maxLength={300}
                      placeholder="https://192.168.11.120:30443"
                      value={origin}
                      disabled={locked}
                      onChange={(event) => {
                        setOrigin(event.target.value);
                        changed();
                      }}
                    />
                  </FormField>
                  <FormField label="Usuário da central">
                    <input
                      className="input"
                      required
                      maxLength={100}
                      autoComplete="off"
                      value={username}
                      disabled={locked}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        changed();
                      }}
                    />
                  </FormField>
                  <FormField
                    label="Senha da central"
                    hint={
                      configuration.passwordConfigured && !credentialsChanged
                        ? 'Já existe uma senha configurada. Deixe em branco para mantê-la.'
                        : 'Informe a senha atual do usuário na central.'
                    }
                  >
                    <input
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      required={!configuration.passwordConfigured || credentialsChanged}
                      maxLength={1024}
                      placeholder={
                        configuration.passwordConfigured && !credentialsChanged
                          ? 'Manter senha atual'
                          : 'Digite a senha da central'
                      }
                      value={password}
                      disabled={locked}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        changed();
                      }}
                    />
                  </FormField>
                  <FormField
                    label="Identificador da integração"
                    hint={
                      configuration.configured
                        ? 'Mantido para preservar os vínculos dos cadastros importados.'
                        : 'Use letras minúsculas, números, hífen ou sublinhado.'
                    }
                  >
                    <input
                      className="input"
                      required
                      pattern="[a-z0-9_-]{2,60}"
                      maxLength={60}
                      value={sourceId}
                      readOnly={configuration.configured}
                      disabled={locked}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                        changed();
                      }}
                    />
                  </FormField>
                </div>
                <details className="form-section" open={needsCertificate || undefined}>
                  <summary className="field-label">Certificado público da central (PEM)</summary>
                  <div className="controlid-certificate-fields">
                    <p className="field-hint">
                      {configuration.certificateValid === false && configuration.configured
                        ? 'O certificado atual está ausente ou fora da validade. Selecione o certificado público confiável da central para reparar a conexão.'
                        : configuration.fingerprint256
                          ? 'O certificado atual será mantido se este campo ficar vazio. Para substituí-lo, selecione o certificado público da central.'
                          : 'Selecione o certificado público confiável da central para verificar a conexão HTTPS.'}
                    </p>
                    <FormField
                      label="Selecionar certificado PEM"
                      hint="Arquivo .pem ou .crt, até 64 KiB, contendo somente o certificado público."
                    >
                      <input
                        className="input"
                        type="file"
                        accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert"
                        disabled={locked}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          void chooseCertificate(file);
                        }}
                      />
                    </FormField>
                    <FormField
                      label="Conteúdo do certificado PEM"
                      hint="Você também pode colar aqui o certificado público."
                    >
                      <textarea
                        className="input"
                        rows={6}
                        maxLength={maxCertificateSize}
                        required={needsCertificate}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="-----BEGIN CERTIFICATE-----"
                        value={certificatePem}
                        disabled={locked}
                        onChange={(event) => {
                          setCertificatePem(event.target.value);
                          changed();
                        }}
                      />
                    </FormField>
                  </div>
                </details>
                {configuration.fingerprint256 && (
                  <div
                    className={
                      configuration.certificateValid === false
                        ? 'notice error'
                        : 'controlid-certificate'
                    }
                  >
                    <ShieldCheck size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        {configuration.certificateValid === false
                          ? 'Certificado precisa de atualização'
                          : 'Certificado configurado'}
                      </strong>
                      <p className="field-hint controlid-fingerprint">
                        SHA-256: {configuration.fingerprint256}
                      </p>
                      <p className="field-hint">
                        Validade: {displayDate(configuration.certificateExpiresAt)}
                      </p>
                    </div>
                  </div>
                )}
                {check && (
                  <p className="field-hint">
                    Último teste nesta tela: {displayDate(check.checkedAt)} ·{' '}
                    {check.connected ? 'Central respondeu' : 'Conexão não confirmada'}.
                  </p>
                )}
                {retryAfter > 0 && (
                  <p className="field-hint" role="status">
                    Aguarde {retryAfter} segundo(s) para uma nova tentativa.
                  </p>
                )}
                <div className="actions controlid-actions">
                  <Button
                    disabled={locked}
                    onClick={() => {
                      setError('');
                      setMessage('');
                      void reload();
                    }}
                  >
                    <RefreshCw size={17} />
                    Recarregar configuração
                  </Button>
                  <Button
                    disabled={locked || retryAfter > 0 || !configuration.version}
                    onClick={() => void submit('test')}
                  >
                    {busy === 'test' ? (
                      <LoaderCircle size={17} className="spinning" />
                    ) : (
                      <Plug size={17} />
                    )}
                    {busy === 'test' ? 'Testando…' : 'Testar conexão'}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={locked || retryAfter > 0 || !configuration.version}
                  >
                    {busy === 'save' ? (
                      <LoaderCircle size={17} className="spinning" />
                    ) : (
                      <Save size={17} />
                    )}
                    {busy === 'save' ? 'Salvando…' : 'Salvar conexão'}
                  </Button>
                </div>
              </form>
            )
          )}
        </div>
      </div>
    </section>
  );
}
