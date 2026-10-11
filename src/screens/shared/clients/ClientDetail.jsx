import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../../lib/store.js';
import { session, canWrite } from '../../../lib/session.js';
import { rpc, message } from '../../../lib/api.js';
import { invalidate } from '../../../lib/query.js';
import { cop } from '../../../lib/money.js';
import { fmtDate } from '../../../lib/dates.js';
import { googleMapsUrl, wazeUrl } from '../../../lib/geo.js';
import { signedUrl } from '../../../lib/images.js';
import { Sheet } from '../../../components/Sheet.jsx';
import { Button, Field, StatusDot } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icon.jsx';
import { toast } from '../../../components/Toast.jsx';
import { CLIENT_STATE, findByDocument } from './data.js';
import { LoanForm } from './LoanForm.jsx';

// Ficha del cliente: datos, cómo llegar, préstamos, fotos y "no prestar más"
function Photos({ client }) {
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    const paths = [['Cédula (frente)', client.id_front_path], ['Cédula (reverso)', client.id_back_path], ['Cliente o negocio', client.photo_path]].filter(([, p]) => p);
    Promise.all(paths.map(([l, p]) => signedUrl(p).then((u) => [l, u]))).then((r) => setUrls(r.filter(([, u]) => u)));
  }, [client.id]);
  if (!urls.length) return null;
  return (
    <div class="photo-grid">
      {urls.map(([label, url]) => (
        <a href={url} target="_blank" rel="noopener" class="photo-input has-photo">
          <img src={url} alt={label} />
          <span>{label}</span>
        </a>
      ))}
    </div>
  );
}

export function ClientDetail({ client, blockedByMe, onClose, onEdit }) {
  const ctx = useStore(session, (s) => s.ctx);
  const isAdmin = ctx.role === 'admin';
  const [mode, setMode] = useState('view');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    setMode('view');
    setReason('');
    setInfo(null);
  }, [client?.id]);

  if (!client) return null;
  const s = CLIENT_STATE[client.state] || CLIENT_STATE.libre;
  const blocked = isAdmin ? client.blocked_by_admin : blockedByMe;
  const hasLoc = client.latitude != null && client.longitude != null;

  const toggleBlock = async () => {
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    setBusy(true);
    try {
      await rpc('set_client_block', { p_client_id: client.id, p_blocked: !blocked, p_reason: !blocked ? reason || null : null });
      toast(!blocked ? (isAdmin ? 'Marcado: todos los cobradores verán la alerta' : 'Marcado: se avisó al administrador') : 'Se quitó la marca');
      invalidate('clients:');
      setMode('view');
      onClose();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const startLoan = async () => {
    try {
      setInfo(await findByDocument(client.document_number));
    } catch {
      setInfo({ client: { blocked_by_admin: client.blocked_by_admin, blocked_by_me: blockedByMe } });
    }
    setMode('loan');
  };

  return (
    <Sheet open={!!client} onClose={onClose} title={mode === 'loan' ? 'Nuevo préstamo' : client.full_name} subtitle={mode === 'loan' ? client.full_name : `C.C. ${client.document_number}`} size="lg">
      {mode === 'loan' ? (
        <LoanForm clientId={client.id} clientName={client.full_name} info={info} onDone={onClose} />
      ) : (
        <div class="form">
          {client.blocked_by_admin && (
            <div class="banner banner-coral" data-enter><Icon name="lock" size={18} /><span>No prestar más{client.blocked_reason ? `: ${client.blocked_reason}` : ''}</span></div>
          )}
          {!isAdmin && blockedByMe && (
            <div class="banner banner-amber" data-enter><Icon name="alert" size={18} /><span>Lo marcaste como "No prestar más".</span></div>
          )}
          <div class="detail-head" data-enter>
            <span class="tag"><StatusDot tone={s.tone} />{s.label}</span>
            {client.balance > 0 && <span class="muted">Debe <b class="num">{cop(client.balance)}</b></span>}
          </div>

          <div class="quick-actions" data-enter>
            <a class="quick" href={`tel:${client.phone}`}><Icon name="phone" size={20} /><span>Llamar</span></a>
            {hasLoc ? (
              <>
                <a class="quick" href={googleMapsUrl(client.latitude, client.longitude)} target="_blank" rel="noopener"><Icon name="pin" size={20} /><span>Google Maps</span></a>
                <a class="quick" href={wazeUrl(client.latitude, client.longitude)} target="_blank" rel="noopener"><Icon name="route" size={20} /><span>Waze</span></a>
              </>
            ) : (
              <span class="quick is-off"><Icon name="pin" size={20} /><span>Sin ubicación</span></span>
            )}
            <button type="button" class="quick" onClick={() => onEdit(client)}><Icon name="settings" size={20} /><span>Editar</span></button>
          </div>

          <section class="list-card list-flat" data-enter>
            <div class="row"><span class="row-icon"><Icon name="pin" size={18} /></span><div class="row-main"><span class="row-title">{client.address || 'Sin dirección'}</span><span class="row-sub">{client.neighborhood}</span></div></div>
            <div class="row"><span class="row-icon"><Icon name="phone" size={18} /></span><div class="row-main"><span class="row-title">{client.phone}</span>{client.phone2 && <span class="row-sub">Otro: {client.phone2}</span>}</div></div>
            {client.occupation && <div class="row"><span class="row-icon"><Icon name="wallet" size={18} /></span><div class="row-main"><span class="row-title">{client.occupation}</span></div></div>}
            {client.reference_name && <div class="row"><span class="row-icon"><Icon name="users" size={18} /></span><div class="row-main"><span class="row-title">{client.reference_name}</span><span class="row-sub">Referencia, {client.reference_phone || 'sin teléfono'}</span></div></div>}
            <div class="row"><span class="row-icon"><Icon name="check" size={18} /></span><div class="row-main"><span class="row-title">{client.data_consent_accepted ? 'Autorizó el tratamiento de datos' : 'Sin autorización de datos'}</span></div></div>
          </section>

          {client.activeLoans?.length > 0 && (
            <section class="form-section" data-enter>
              <h3>Préstamos activos</h3>
              {client.activeLoans.map((l) => (
                <div class="row">
                  <div class="row-main"><span class="row-title num">{cop(l.principal)}</span><span class="row-sub">Cuota {cop(l.daily_payment)}, vence {fmtDate(l.due_date)}</span></div>
                  <span class={`tag ${l.status === 'en_mora' ? 'tag-coral' : 'tag-lime'}`}>{l.status === 'en_mora' ? 'En mora' : 'Activo'}</span>
                </div>
              ))}
            </section>
          )}

          <Photos client={client} />

          <Button size="lg" class="btn-block" icon="plus" onClick={startLoan}>Nuevo préstamo</Button>

          {mode === 'block' ? (
            <section class="form-section" data-enter>
              <h3>Marcar como "No prestar más"</h3>
              <p class="muted">{isAdmin ? 'Todos los cobradores verán la alerta.' : 'Se le avisará al administrador y verás una alerta si intentas prestarle.'}</p>
              <Field label="Motivo (opcional)" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
              <div class="form-actions">
                <Button variant="ghost" onClick={() => setMode('view')}>Cancelar</Button>
                <Button loading={busy} class="btn-grow" onClick={toggleBlock}>Marcar</Button>
              </div>
            </section>
          ) : (
            <button type="button" class="link-btn center" onClick={() => (blocked ? toggleBlock() : setMode('block'))}>
              {blocked ? 'Quitar la marca "No prestar más"' : 'Marcar como "No prestar más"'}
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
