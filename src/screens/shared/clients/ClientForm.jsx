import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../../lib/store.js';
import { session, canWrite } from '../../../lib/session.js';
import { message } from '../../../lib/api.js';
import { send, uuid } from '../../../lib/outbox.js';
import { invalidate, useQuery } from '../../../lib/query.js';
import { getPosition, reverseGeocode, searchAddress } from '../../../lib/geo.js';
import { savePending, uploadClientPhotos } from '../../../lib/images.js';
import { Sheet } from '../../../components/Sheet.jsx';
import { Button, Field } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icon.jsx';
import { MapPicker } from '../../../components/Map.jsx';
import { PhotoInput } from '../../../components/PhotoInput.jsx';
import { SignaturePad } from '../../../components/SignaturePad.jsx';
import { toast } from '../../../components/Toast.jsx';
import { CLIENT_STATE, fetchClients, findByDocument } from './data.js';
import { Avatar, StatusDot } from '../../../components/ui.jsx';
import { LoanForm } from './LoanForm.jsx';
import { RiskAlerts } from './RiskAlerts.jsx';

// Acá se crea o edita un cliente: cédula, datos, ubicación, fotos y autorización de datos
const EMPTY = { document_number: '', full_name: '', phone: '', neighborhood: '', address: '', phone2: '', occupation: '', reference_name: '', reference_phone: '', notes: '' };

const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const onlyDigits = (t) => /^[\d.\s-]+$/.test(t.trim());

export function ClientForm({ open, onClose, editing = null }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const [term, setTerm] = useState('');
  const clients = useQuery(open && !editing ? `clients:${userId}` : null, fetchClients, { persist: true });
  const [step, setStep] = useState('doc');
  const [f, setF] = useState(EMPTY);
  const [info, setInfo] = useState(null);
  const [loc, setLoc] = useState(null);
  const [photos, setPhotos] = useState({});
  const [consent, setConsent] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState('');
  const [clientId, setClientId] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPhotos({});
    setMore(false);
    setBusy('');
    setClientId(null);
    if (editing) {
      setF({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, editing[k] || ''])) });
      setLoc(editing.latitude != null ? { lat: Number(editing.latitude), lng: Number(editing.longitude) } : null);
      setConsent(!!editing.data_consent_accepted);
      setInfo(null);
      setStep('form');
    } else {
      setF(EMPTY);
      setLoc(null);
      setConsent(false);
      setInfo(null);
      setTerm('');
      setStep('doc');
    }
  }, [open, editing?.id]);

  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });

  // Busca la cédula: si ya existe en la ruta, llena los datos
  const lookup = async (e, given) => {
    e?.preventDefault?.();
    const doc = (given ?? f.document_number).replace(/\D/g, '');
    if (doc.length < 5) return toast('Escribe la cédula completa.', 'error');
    setF((cur) => ({ ...cur, document_number: doc }));
    setBusy('doc');
    try {
      const r = await findByDocument(doc);
      setInfo(r);
      if (r.client) {
        const c = r.client;
        setF({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, c[k] || ''])), document_number: c.document_number });
        setConsent(!!c.data_consent_accepted);
        toast('Cliente encontrado: revisa la ubicación y sigue con el préstamo', 'info');
      }
    } catch (err) {
      if (!/conexi/i.test(message(err))) return toast(message(err), 'error');
      toast('Sin señal: no se pudo revisar si el cliente existe. Puedes continuar.', 'info');
    } finally {
      setBusy('');
      setStep('form');
      takeLocation(true);
    }
  };

  // Búsqueda por nombre (principal) o por cédula en los clientes ya cargados
  const matches = (() => {
    const t = norm(term);
    if (t.length < 2) return [];
    const digits = term.replace(/\D/g, '');
    return (clients.data || [])
      .filter((c) => norm(c.full_name).includes(t) || (digits.length >= 3 && c.document_number.includes(digits)))
      .slice(0, 8);
  })();

  // Cliente nuevo: si escribió una cédula, se revisa en toda la ruta; si escribió un nombre, se llena el formulario
  const startNew = (e) => {
    e?.preventDefault();
    const digits = term.replace(/\D/g, '');
    if (onlyDigits(term) && digits.length >= 5) return lookup(null, digits);
    setF({ ...EMPTY, full_name: onlyDigits(term) ? '' : term.trim() });
    setInfo(null);
    setStep('form');
    takeLocation(true);
  };

  // Al escribir la cédula en un cliente nuevo, se revisa si ya existe o tiene alertas
  const checkDoc = async () => {
    const doc = f.document_number.replace(/\D/g, '');
    if (editing || info?.client || doc.length < 5) return;
    try {
      const r = await findByDocument(doc);
      setInfo(r);
      if (r.client) {
        const c = r.client;
        setF((cur) => ({ ...cur, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, c[k] || cur[k] || ''])), document_number: c.document_number }));
        setConsent(!!c.data_consent_accepted);
        toast('Esa cédula ya existe: cargamos sus datos', 'info');
      }
    } catch {}
  };

  // Toma la ubicación actual; si la dirección está vacía, intenta llenarla
  const takeLocation = async (silent = false) => {
    setBusy((b) => b || 'gps');
    try {
      const p = await getPosition();
      setLoc(p);
      if (!f.address || !f.neighborhood) {
        const r = await reverseGeocode(p.lat, p.lng).catch(() => null);
        if (r) setF((cur) => ({ ...cur, address: cur.address || r.address, neighborhood: cur.neighborhood || r.neighborhood }));
      }
    } catch (err) {
      if (!silent) toast(err.message, 'error');
    } finally {
      setBusy((b) => (b === 'gps' ? '' : b));
    }
  };

  const locateAddress = async () => {
    if (!f.address.trim()) return toast('Escribe la dirección primero.', 'error');
    setBusy('search');
    try {
      const r = await searchAddress(`${f.address}, ${f.neighborhood}`);
      if (r) setLoc(r);
      else toast('No encontramos esa dirección en el mapa. Mueve el punto a mano.', 'info');
    } catch {
      toast('Sin conexión para buscar la dirección.', 'error');
    } finally {
      setBusy('');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    const missing = ['document_number', 'full_name', 'phone', 'neighborhood', 'address'].filter((k) => !String(f[k]).trim());
    if (missing.length) return toast('Completa cédula, nombre, teléfono, barrio y dirección.', 'error');
    setBusy('save');
    const key = uuid();
    const method = photos.signature ? 'firma' : photos.consent ? 'foto' : 'casilla';
    const args = {
      p_document: f.document_number,
      p_full_name: f.full_name,
      p_phone: f.phone,
      p_neighborhood: f.neighborhood,
      p_address: f.address,
      p_latitude: loc?.lat ?? null,
      p_longitude: loc?.lng ?? null,
      p_phone2: f.phone2 || null,
      p_occupation: f.occupation || null,
      p_reference_name: f.reference_name || null,
      p_reference_phone: f.reference_phone || null,
      p_notes: f.notes || null,
      p_consent: consent,
      p_consent_method: consent ? method : null,
      p_client_uuid: key
    };
    const hasPhotos = Object.values(photos).some(Boolean);
    try {
      if (hasPhotos) await savePending(key, photos);
      const { data, queued } = await send('upsert_client', args, hasPhotos ? { type: 'client-photos', key, orgId: ctx.organization.id } : null);
      invalidate('clients:');
      if (queued) {
        toast('Cliente guardado sin señal. Se enviará cuando vuelva la conexión.', 'info');
        return onClose();
      }
      if (hasPhotos) {
        await uploadClientPhotos(ctx.organization.id, data, photos).catch(() => toast('El cliente se guardó, pero las fotos no se pudieron subir.', 'error'));
      }
      toast(editing ? 'Cliente actualizado' : 'Cliente guardado');
      if (editing) return onClose();
      setClientId(data);
      setStep('loan');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy('');
    }
  };

  const title = step === 'loan' ? 'Nuevo préstamo' : editing ? 'Editar cliente' : 'Nuevo cliente';

  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={step === 'doc' ? 'Busca por nombre o cédula' : step === 'loan' ? f.full_name : null} size="lg">
      {step === 'doc' && (
        <form class="form" onSubmit={startNew}>
          <div data-enter>
            <Field label="Buscar cliente" value={term} onInput={(e) => setTerm(e.currentTarget.value)} prefix={<Icon name="search" size={18} />} placeholder="Nombre o cédula" autocomplete="off" autofocus />
          </div>
          {matches.length > 0 && (
            <div class="pick-list" data-enter>
              {matches.map((c) => (
                <button type="button" class="row row-button" onClick={() => lookup(null, c.document_number)}>
                  <Avatar name={c.full_name} size={40} />
                  <div class="row-main">
                    <span class="row-title">{c.full_name}</span>
                    <span class="row-sub"><StatusDot tone={CLIENT_STATE[c.state].tone} /> CC {c.document_number}{c.neighborhood ? `, ${c.neighborhood}` : ''}</span>
                  </div>
                  <Icon name="chevron" size={18} class="row-chevron" />
                </button>
              ))}
            </div>
          )}
          {term.trim().length >= 2 && !matches.length && (
            <p class="muted center" data-enter>
              {onlyDigits(term) ? 'No está en tu lista. Al continuar revisamos esa cédula en toda la ruta.' : 'No encontramos ese nombre en tus clientes. Si ya existe con otro cobrador, búscalo por cédula.'}
            </p>
          )}
          <Button type="submit" size="lg" class="btn-block" variant={matches.length ? 'ghost' : 'lime'} loading={busy === 'doc'} icon="plus">
            {onlyDigits(term) && term.replace(/\D/g, '').length >= 5 ? 'Buscar cédula y continuar' : 'Crear cliente nuevo'}
          </Button>
        </form>
      )}

      {step === 'form' && (
        <form class="form" onSubmit={save}>
          <RiskAlerts info={info} />
          <section class="form-section" data-enter>
            <h3>Datos</h3>
            <div class="form-row">
              <Field label="Cédula" inputMode="numeric" value={f.document_number} onInput={set('document_number')} onBlur={checkDoc} disabled={!!editing || !!info?.client} />
              <Field label="Nombre completo" value={f.full_name} onInput={set('full_name')} />
            </div>
            <div class="form-row">
              <Field label="Teléfono" type="tel" inputMode="tel" value={f.phone} onInput={set('phone')} />
              <Field label="Barrio" value={f.neighborhood} onInput={set('neighborhood')} />
            </div>
            <Field label="Dirección" value={f.address} onInput={set('address')} placeholder="Ej. Cra 45 #72-30" />
            <button type="button" class="link-btn" onClick={() => setMore(!more)}>{more ? 'Ocultar datos opcionales' : 'Agregar datos opcionales'}</button>
            {more && (
              <>
                <div class="form-row">
                  <Field label="Otro teléfono" type="tel" value={f.phone2} onInput={set('phone2')} />
                  <Field label="Negocio u ocupación" value={f.occupation} onInput={set('occupation')} />
                </div>
                <div class="form-row">
                  <Field label="Referencia (nombre)" value={f.reference_name} onInput={set('reference_name')} />
                  <Field label="Referencia (teléfono)" type="tel" value={f.reference_phone} onInput={set('reference_phone')} />
                </div>
                <Field label="Notas" value={f.notes} onInput={set('notes')} />
              </>
            )}
          </section>

          <section class="form-section" data-enter>
            <h3>Ubicación</h3>
            <p class="muted">Toca el mapa o arrastra el punto para corregirla.</p>
            <div class="chips chips-left">
              <button type="button" class="chip" onClick={() => takeLocation(false)}>
                <Icon name="pin" size={16} /> {busy === 'gps' ? 'Ubicando…' : 'Usar mi ubicación'}
              </button>
              <button type="button" class="chip" onClick={locateAddress}>
                <Icon name="search" size={16} /> {busy === 'search' ? 'Buscando…' : 'Buscar la dirección'}
              </button>
            </div>
            <MapPicker value={loc} onChange={setLoc} />
            {!loc && <p class="field-hint">Sin ubicación todavía. Puedes guardar y agregarla después.</p>}
          </section>

          <section class="form-section" data-enter>
            <h3>Fotos (opcionales)</h3>
            <div class="photo-grid">
              <PhotoInput label="Cédula (frente)" value={photos.front} onChange={(b) => setPhotos({ ...photos, front: b })} />
              <PhotoInput label="Cédula (reverso)" value={photos.back} onChange={(b) => setPhotos({ ...photos, back: b })} />
              <PhotoInput label="Cliente o negocio" value={photos.photo} onChange={(b) => setPhotos({ ...photos, photo: b })} />
            </div>
          </section>

          <section class="form-section" data-enter>
            <h3>Tratamiento de datos</h3>
            <label class="check-row">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} />
              <span>
                El cliente autoriza el tratamiento de sus datos personales según la{' '}
                <a href="/tratamiento-datos" target="_blank" rel="noopener" class="link-btn">política de tratamiento de datos</a>.
              </span>
            </label>
            {consent && (
              <>
                <SignaturePad onChange={(b) => setPhotos((p) => ({ ...p, signature: b }))} />
                <PhotoInput label="Foto del papel firmado (opcional)" value={photos.consent} onChange={(b) => setPhotos({ ...photos, consent: b })} />
              </>
            )}
            {!consent && <p class="field-hint">Puedes guardar sin la autorización y pedirla después.</p>}
          </section>

          <Button type="submit" size="lg" class="btn-block" loading={busy === 'save'} icon="check">
            {editing ? 'Guardar cambios' : 'Guardar y seguir al préstamo'}
          </Button>
        </form>
      )}

      {step === 'loan' && clientId && <LoanForm clientId={clientId} clientName={f.full_name} info={info} onDone={onClose} />}
    </Sheet>
  );
}
