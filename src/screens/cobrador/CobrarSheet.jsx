import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, canWrite } from '../../lib/session.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { send, uuid } from '../../lib/outbox.js';
import { cop, parseCop } from '../../lib/money.js';
import { message } from '../../lib/api.js';
import { Sheet } from '../../components/Sheet.jsx';
import { Avatar, Button, Field, Pills, Select, StatusDot } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { SuccessBurst } from '../../components/SuccessBurst.jsx';
import { fetchAccounts, STATE } from './data.js';

// Acá se registra un cobro: elegir cliente, monto, método (efectivo o transferencia)
const LOG_TYPES = [
  { value: 'no_pago', label: 'No pagó' },
  { value: 'pago_parcial', label: 'Pago parcial' },
  { value: 'promesa_pago', label: 'Promete pagar' },
  { value: 'cliente_ausente', label: 'No estaba' },
  { value: 'otro', label: 'Otro' }
];

function ClientPicker({ items, onPick }) {
  const [term, setTerm] = useState('');
  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    return t ? items.filter((i) => i.client.full_name.toLowerCase().includes(t) || i.client.document_number?.includes(t)) : items;
  }, [items, term]);
  return (
    <div class="form">
      <Field label="Buscar cliente" value={term} onInput={(e) => setTerm(e.currentTarget.value)} placeholder="Nombre o cédula" prefix={<Icon name="search" size={18} />} />
      <div class="pick-list">
        {list.map((i) => (
          <button type="button" class="row row-button" onClick={() => onPick(i)} data-enter>
            <Avatar name={i.client.full_name} size={40} />
            <div class="row-main">
              <span class="row-title">{i.client.full_name}</span>
              <span class="row-sub"><StatusDot tone={STATE[i.state].tone} /> {STATE[i.state].label}</span>
            </div>
            <span class="row-amount num">{cop(Math.max(i.daily, i.owedToDate))}</span>
          </button>
        ))}
        {!list.length && <p class="muted center">No hay clientes con ese nombre en tu ruta.</p>}
      </div>
    </div>
  );
}

export function CobrarSheet({ open, onClose, items = [], preset }) {
  const userId = useStore(session, (s) => s.user?.id);
  const [loan, setLoan] = useState(preset || null);
  const [mode, setMode] = useState('cobro');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('efectivo');
  const [account, setAccount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [logType, setLogType] = useState('no_pago');
  const [promised, setPromised] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const accounts = useQuery(open ? 'accounts' : null, fetchAccounts, { persist: true });

  useEffect(() => {
    if (!open) return;
    setLoan(preset || null);
    setMode('cobro');
    setAmount(preset ? String(Math.max(preset.daily, Math.min(preset.owedToDate, preset.balance)) || preset.daily) : '');
    setMethod('efectivo');
    setReference('');
    setNote('');
  }, [open, preset?.id]);

  const pick = (i) => {
    setLoan(i);
    setAmount(String(Math.max(i.daily, Math.min(i.owedToDate, i.balance)) || i.daily));
  };

  const value = parseCop(amount);
  const quick = loan
    ? [
        { label: 'Cuota', v: loan.daily },
        loan.owedToDate > loan.daily && { label: 'Al día', v: Math.round(loan.owedToDate) },
        { label: 'Todo', v: Math.round(loan.balance) }
      ].filter(Boolean)
    : [];

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    setBusy(true);
    try {
      if (mode === 'cobro') {
        if (value <= 0) throw new Error('Escribe el monto que recibiste.');
        if (value > loan.balance + 0.5) throw new Error(`El cliente debe ${cop(loan.balance)}. El abono no puede ser mayor.`);
        if (method === 'transferencia' && !account) throw new Error('Elige la cuenta que recibió la transferencia.');
        let coords = {};
        try {
          coords = await new Promise((res) =>
            navigator.geolocation
              ? navigator.geolocation.getCurrentPosition((p) => res({ p_latitude: p.coords.latitude, p_longitude: p.coords.longitude }), () => res({}), { timeout: 2500, maximumAge: 60000 })
              : res({})
          );
        } catch {}
        const { queued } = await send('register_payment', {
          p_loan_id: loan.id,
          p_amount: value,
          p_method: method,
          p_account_id: method === 'transferencia' ? account : null,
          p_transfer_reference: method === 'transferencia' ? reference || null : null,
          p_notes: note || null,
          p_paid_at: new Date().toISOString(),
          p_client_uuid: uuid(),
          ...coords
        });
        setDone({ amount: value, queued, detail: `${loan.client.full_name}${method === 'transferencia' ? ', transferencia por verificar' : ''}` });
      } else if (mode === 'papeleria') {
        if (method === 'transferencia' && !account) throw new Error('Elige la cuenta que recibió la transferencia.');
        const { queued } = await send('charge_paperwork', {
          p_loan_id: loan.id,
          p_method: method,
          p_account_id: method === 'transferencia' ? account : null,
          p_transfer_reference: method === 'transferencia' ? reference || null : null,
          p_paid_at: new Date().toISOString(),
          p_client_uuid: uuid()
        });
        setDone({ amount: loan.paperwork, queued, title: 'Papelería cobrada', detail: `${loan.client.full_name}${method === 'transferencia' ? ', transferencia por verificar' : ''}` });
      } else {
        const { queued } = await send('add_collection_log', {
          p_loan_id: loan.id,
          p_type: logType,
          p_note: note || null,
          p_promised_date: logType === 'promesa_pago' ? promised || null : null,
          p_client_uuid: uuid()
        });
        toast(queued ? 'Observación guardada. Se enviará al volver la señal.' : 'Observación guardada');
        invalidate('route:');
        onClose();
      }
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    setDone(null);
    invalidate('route:');
    invalidate('summary:');
    onClose();
  };

  if (done) return <SuccessBurst amount={done.amount} title={done.title} detail={done.detail} queued={done.queued} onDone={finish} />;

  return (
    <Sheet open={open} onClose={onClose} title={loan ? loan.client.full_name : 'Cobrar'} subtitle={loan ? `Debe ${cop(loan.balance)}, cuota de ${cop(loan.daily)}${loan.paperwork > 0 ? `, papelería ${cop(loan.paperwork)}` : ''}` : 'Elige el cliente de tu ruta'}>
      {!loan ? (
        <ClientPicker items={items} onPick={pick} />
      ) : (
        <form class="form" onSubmit={submit}>
          <div data-enter>
            <Pills
              label="Tipo de registro"
              value={mode}
              onChange={setMode}
              options={[{ value: 'cobro', label: 'Registrar abono' }, loan.paperwork > 0 && { value: 'papeleria', label: 'Papelería' }, { value: 'obs', label: 'Observación' }].filter(Boolean)}
            />
          </div>

          {mode === 'papeleria' && (
            <div class="paperwork-card" data-enter>
              <span class="muted">Papelería (cobro único)</span>
              <b class="num">{cop(loan.paperwork)}</b>
              <span class="field-hint">Se cobra una sola vez. Es tuya: no se suma a las cuotas ni a lo que entregas en el cuadre.</span>
            </div>
          )}

          {mode !== 'obs' ? (
            <>
              {mode === 'cobro' && (
                <>
                  <div class="amount-input" data-enter>
                    <span class="amount-currency">$</span>
                    <input
                      class="amount-field num"
                      size={Math.max(2, value.toLocaleString('es-CO').length)}
                      inputMode="numeric"
                      aria-label="Monto recibido"
                      value={value ? value.toLocaleString('es-CO') : ''}
                      onInput={(e) => setAmount(e.currentTarget.value)}
                      placeholder="0"
                    />
                  </div>
                  <div class="chips" data-enter>
                    {quick.map((c) => (
                      <button type="button" class={`chip ${value === c.v ? 'is-active' : ''}`} onClick={() => setAmount(String(c.v))}>
                        {c.label} <b class="num">{cop(c.v)}</b>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div data-enter>
                <Pills label="Método de pago" value={method} onChange={setMethod} options={[{ value: 'efectivo', label: 'Efectivo' }, { value: 'transferencia', label: 'Transferencia' }]} />
              </div>
              {method === 'transferencia' && (
                <>
                  <div data-enter>
                    <Select label="Cuenta que recibió" value={account} onChange={(e) => setAccount(e.currentTarget.value)}>
                      <option value="">Elige una cuenta</option>
                      {(accounts.data || []).map((a) => (
                        <option value={a.id}>{a.name}{a.collector_id === userId ? ' (mía)' : ''}</option>
                      ))}
                    </Select>
                  </div>
                  <div data-enter>
                    <Field label="Número de comprobante" hint="Opcional. Evita registrar dos veces la misma transferencia." value={reference} onInput={(e) => setReference(e.currentTarget.value)} />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div data-enter>
                <Pills label="Motivo" value={logType} onChange={setLogType} options={LOG_TYPES} />
              </div>
              {logType === 'promesa_pago' && (
                <div data-enter>
                  <Field label="¿Cuándo promete pagar?" type="date" value={promised} onInput={(e) => setPromised(e.currentTarget.value)} />
                </div>
              )}
            </>
          )}

          {mode !== 'papeleria' && (
          <div data-enter>
            <Field label={mode !== 'obs' ? 'Nota (opcional)' : 'Detalle'} value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={mode !== 'obs' ? 'Ej. pagó con billetes de 50' : 'Ej. paga mañana el faltante'} />
          </div>
          )}

          <div class="form-actions" data-enter>
            {!preset && <Button variant="ghost" onClick={() => setLoan(null)}>Cambiar cliente</Button>}
            {canWrite() ? (
              <Button type="submit" size="lg" loading={busy} class="btn-grow" icon={mode === 'obs' ? 'logs' : 'check'}>
                {mode === 'cobro' ? `Cobrar ${value ? cop(value) : ''}` : mode === 'papeleria' ? `Cobrar papelería ${cop(loan.paperwork)}` : 'Guardar observación'}
              </Button>
            ) : (
              <Button type="submit" size="lg" variant="ghost" class="btn-grow" icon="lock">Solo lectura</Button>
            )}
          </div>
        </form>
      )}
    </Sheet>
  );
}
