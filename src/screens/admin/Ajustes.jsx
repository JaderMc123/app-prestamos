import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, canWrite, refreshContext } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q, rpc, message } from '../../lib/api.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { cop, parseCop } from '../../lib/money.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Button, Field, Pills, Select, Skeleton, Switch } from '../../components/ui.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';

// Acá el administrador configura su ruta: nombre, mora, cuentas de pago y capital base
const ACCOUNT_TYPES = [
  { value: 'nequi', label: 'Nequi' },
  { value: 'bancolombia', label: 'Bancolombia' },
  { value: 'daviplata', label: 'Daviplata' },
  { value: 'otro_banco', label: 'Otro banco' },
  { value: 'otro', label: 'Otro' }
];

const guard = () => {
  if (canWrite()) return true;
  toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
  return false;
};

function MoraSection({ settings, orgId }) {
  const [enabled, setEnabled] = useState(settings.late_fee_enabled);
  const [type, setType] = useState(settings.late_fee_type || 'porcentaje');
  const [value, setValue] = useState(settings.late_fee_value ?? '');
  const [grace, setGrace] = useState(settings.late_fee_grace_days ?? 0);
  const [recurring, setRecurring] = useState(settings.late_fee_recurring);
  const [every, setEvery] = useState(settings.late_fee_every_days ?? 7);
  const [busy, setBusy] = useState(false);

  const num = type === 'fijo' ? parseCop(value) : Number(String(value).replace(',', '.')) || 0;
  const example = type === 'fijo' ? num : Math.round((100000 * num) / 100);

  const save = async () => {
    if (!guard()) return;
    if (enabled && num <= 0) return toast('Escribe el valor de la mora.', 'error');
    setBusy(true);
    try {
      await q(
        supabase
          .from('settings')
          .update({
            late_fee_enabled: enabled,
            late_fee_type: enabled ? type : settings.late_fee_type,
            late_fee_value: enabled ? num : settings.late_fee_value,
            late_fee_base: 'capital',
            late_fee_grace_days: Number(grace) || 0,
            late_fee_recurring: enabled && recurring,
            late_fee_every_days: recurring ? Number(every) || 7 : null
          })
          .eq('organization_id', orgId)
      );
      toast('Configuración guardada');
      invalidate('admin:settings');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-coral"><Icon name="alert" size={19} /></span>
        <div>
          <h2>Recargo por mora</h2>
          <p class="muted">Se suma cuando el préstamo pasa la fecha límite sin pagarse.</p>
        </div>
      </header>
      <Switch label="Cobrar recargo por mora" checked={enabled} onChange={setEnabled} />
      {enabled && (
        <div class="form">
          <Pills label="Tipo de recargo" value={type} onChange={setType} options={[{ value: 'porcentaje', label: 'Porcentaje del préstamo' }, { value: 'fijo', label: 'Valor fijo' }]} />
          <div class="form-row">
            <Field
              label={type === 'fijo' ? 'Valor' : 'Porcentaje'}
              inputMode="decimal"
              value={type === 'fijo' ? (num ? num.toLocaleString('es-CO') : '') : value}
              onInput={(e) => setValue(e.currentTarget.value)}
              prefix={type === 'fijo' ? '$' : null}
              suffix={type === 'porcentaje' ? <span class="field-affix">%</span> : null}
            />
            <Field label="Días después de la fecha límite" type="number" min="0" inputMode="numeric" value={grace} onInput={(e) => setGrace(e.currentTarget.value)} />
          </div>
          <Switch label="Repetir el recargo" hint="Se vuelve a sumar mientras siga en mora." checked={recurring} onChange={setRecurring} />
          {recurring && <Field label="Cada cuántos días" type="number" min="1" inputMode="numeric" value={every} onInput={(e) => setEvery(e.currentTarget.value)} />}
          <p class="example">
            Ejemplo: un préstamo de {cop(100000)} que entra en mora suma <b class="num">{cop(example)}</b>
            {recurring ? ` cada ${every || 7} días` : ' una sola vez'}.
          </p>
        </div>
      )}
      <Button loading={busy} onClick={save}>Guardar cambios</Button>
    </section>
  );
}

// Acá el admin define el interés de los préstamos y qué frecuencias de cobro puede usar el cobrador
const FREQ_OPTIONS = [
  { value: 'diario', label: 'Diario', hint: 'Según los días de cobro de cada cobrador.' },
  { value: 'quincenal', label: 'Quincenal', hint: 'Los días 15 y 30 de cada mes.' },
  { value: 'mensual', label: 'Mensual', hint: 'El mismo día de cada mes.' }
];

// Redondeo: la cuota se deja en un número fácil de cobrar y lo que sobra se cobra en la última cuota
const ROUNDING = [
  { value: '0', label: 'Sin redondear' },
  { value: '50', label: '$50' },
  { value: '100', label: '$100' },
  { value: '500', label: '$500' },
  { value: '1000', label: '$1.000' }
];

function RoundingPicker({ value, onChange, total }) {
  const n = 26;
  const r = Number(value);
  let per = r > 0 ? Math.floor(total / n / r) * r : 0;
  if (per <= 0) per = Math.floor((total / n) * 100) / 100;
  const last = total - per * (n - 1);
  const money = (v) => (Number.isInteger(v) ? cop(v) : '$' + v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return (
    <div class="form">
      <span class="field-label">Redondear la cuota a</span>
      <Pills label="Redondear la cuota a" value={value} onChange={onChange} options={ROUNDING} />
      <p class="example">
        Con {n} cuotas de ese préstamo, el cobrador recibe <b class="num">{money(per)}</b> cada día
        {Math.abs(last - per) >= 0.01 ? <> y en la última cuota <b class="num">{money(last)}</b>, para completar lo que falta</> : null}.
        {r === 0 ? ' La cuota puede quedar con centavos, difícil de cobrar en efectivo.' : ` Así no hay que dar ni pedir monedas sueltas.`}
      </p>
    </div>
  );
}

function LoanSection({ settings, orgId }) {
  const [rate, setRate] = useState(String(Number(settings.default_interest_rate ?? 20)));
  const [freqs, setFreqs] = useState(settings.frequencies?.length ? settings.frequencies : ['diario']);
  const [rounding, setRounding] = useState(String(settings.installment_rounding ?? 100));
  const [busy, setBusy] = useState(false);
  const pct = Number(String(rate).replace(',', '.'));

  const toggle = (f, on) => {
    const next = on ? [...new Set([...freqs, f])] : freqs.filter((x) => x !== f);
    if (!next.length) return toast('Debe quedar al menos una frecuencia activa.', 'error');
    setFreqs(FREQ_OPTIONS.map((o) => o.value).filter((v) => next.includes(v)));
  };

  const save = async () => {
    if (!guard()) return;
    if (!(pct >= 0) || pct > 1000) return toast('Escribe un interés válido.', 'error');
    setBusy(true);
    try {
      await q(supabase.from('settings').update({ default_interest_rate: pct, frequencies: freqs, installment_rounding: Number(rounding) }).eq('organization_id', orgId));
      toast('Configuración de préstamos guardada');
      invalidate('admin:settings');
      invalidate('settings:loan:');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lime"><Icon name="cash" size={19} /></span>
        <div>
          <h2>Préstamos</h2>
          <p class="muted">El interés lo pones tú; el cobrador no lo puede cambiar.</p>
        </div>
      </header>
      <Field label="Interés de los préstamos" inputMode="decimal" value={rate} onInput={(e) => setRate(e.currentTarget.value)} suffix={<span class="field-affix">%</span>} hint="Es el mismo porcentaje sin importar si se cobra diario, quincenal o mensual." />
      <div class="form">
        <span class="field-label">Frecuencias que puede escoger el cobrador</span>
        {FREQ_OPTIONS.map((o) => (
          <Switch label={o.label} hint={o.hint} checked={freqs.includes(o.value)} onChange={(on) => toggle(o.value, on)} />
        ))}
      </div>
      <p class="example">
        Ejemplo: {cop(100000)} al {pct || 0}% = <b class="num">{cop(Math.round(100000 * (1 + (pct || 0) / 100)))}</b> en total.
      </p>
      <RoundingPicker value={rounding} onChange={setRounding} total={Math.round(100000 * (1 + (pct || 0) / 100))} />
      <Button loading={busy} onClick={save}>Guardar cambios</Button>
    </section>
  );
}

function AccountsSection({ orgId }) {
  const accounts = useQuery('admin:accounts', () => q(supabase.from('payment_accounts').select('id,name,type,account_number,owner_name,is_active,collector:profiles(full_name)').order('created_at')));
  const collectors = useQuery('admin:collectors-min', () => q(supabase.from('profiles').select('id,full_name').eq('role', 'cobrador').eq('is_active', true).order('full_name')));
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'nequi', account_number: '', owner_name: '', collector_id: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });

  const add = async (e) => {
    e.preventDefault();
    if (!guard()) return;
    if (!form.name.trim()) return toast('Ponle un nombre a la cuenta.', 'error');
    setBusy(true);
    try {
      await q(supabase.from('payment_accounts').insert({ organization_id: orgId, name: form.name.trim(), type: form.type, account_number: form.account_number || null, owner_name: form.owner_name || null, collector_id: form.collector_id || null }));
      toast('Cuenta agregada');
      setOpen(false);
      setForm({ name: '', type: 'nequi', account_number: '', owner_name: '', collector_id: '' });
      accounts.reload();
      invalidate('accounts');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a) => {
    if (!guard()) return;
    try {
      await q(supabase.from('payment_accounts').update({ is_active: !a.is_active }).eq('id', a.id));
      accounts.reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lav"><Icon name="transfer" size={19} /></span>
        <div>
          <h2>Cuentas para transferencias</h2>
          <p class="muted">Donde los clientes pueden pagar por Nequi, Bancolombia u otro banco.</p>
        </div>
      </header>
      {accounts.loading && !accounts.data ? (
        <Skeleton h={56} r={16} />
      ) : (
        <div class="list-card list-flat">
          {(accounts.data || []).map((a) => (
            <div class={`row ${a.is_active ? '' : 'is-off'}`}>
              <span class="row-icon"><Icon name="wallet" size={18} /></span>
              <div class="row-main">
                <span class="row-title">{a.name}</span>
                <span class="row-sub">{a.collector ? `Personal de ${a.collector.full_name}` : 'De la ruta'}{a.account_number ? `, ${a.account_number}` : ''}</span>
              </div>
              <button type="button" class="link-btn" onClick={() => toggle(a)}>{a.is_active ? 'Desactivar' : 'Activar'}</button>
            </div>
          ))}
          {!accounts.data?.length && <p class="muted">Aún no hay cuentas. Agrega una para recibir transferencias.</p>}
        </div>
      )}
      <Button variant="ghost" icon="plus" onClick={() => setOpen(true)}>Agregar cuenta</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nueva cuenta">
        <form class="form" onSubmit={add}>
          <div data-enter><Field label="Nombre" placeholder="Ej. Nequi de la ruta" value={form.name} onInput={set('name')} /></div>
          <div data-enter>
            <Select label="Tipo" value={form.type} onChange={set('type')}>
              {ACCOUNT_TYPES.map((t) => <option value={t.value}>{t.label}</option>)}
            </Select>
          </div>
          <div data-enter><Field label="Número (opcional)" inputMode="numeric" value={form.account_number} onInput={set('account_number')} /></div>
          <div data-enter><Field label="Titular (opcional)" value={form.owner_name} onInput={set('owner_name')} /></div>
          <div data-enter>
            <Select label="¿De quién es?" value={form.collector_id} onChange={set('collector_id')}>
              <option value="">De la ruta (administrador)</option>
              {(collectors.data || []).map((c) => <option value={c.id}>Personal de {c.full_name}</option>)}
            </Select>
          </div>
          <Button type="submit" size="lg" loading={busy} class="btn-block">Agregar cuenta</Button>
        </form>
      </Sheet>
    </section>
  );
}

function CapitalSection() {
  const [amount, setAmount] = useState('');
  const [withdraw, setWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = parseCop(amount);
  const submit = async () => {
    if (!guard() || !v) return;
    setBusy(true);
    try {
      await rpc('add_capital', { p_amount: v, p_is_withdrawal: withdraw, p_note: withdraw ? 'Retiro del administrador' : 'Aporte a la base' });
      toast(withdraw ? `Retiraste ${cop(v)}` : `Agregaste ${cop(v)} a la base`);
      setAmount('');
      invalidate('admin:');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lime"><Icon name="wallet" size={19} /></span>
        <div>
          <h2>Base de capital</h2>
          <p class="muted">El dinero con el que trabaja la ruta. Luego lo asignas a cada cobrador.</p>
        </div>
      </header>
      <Pills label="Movimiento" value={withdraw ? 'out' : 'in'} onChange={(x) => setWithdraw(x === 'out')} options={[{ value: 'in', label: 'Agregar' }, { value: 'out', label: 'Retirar' }]} />
      <div class="inline-form">
        <Field label="Monto" inputMode="numeric" prefix="$" value={v ? v.toLocaleString('es-CO') : ''} onInput={(e) => setAmount(e.currentTarget.value)} />
        <Button loading={busy} disabled={!v} onClick={submit}>{withdraw ? 'Retirar' : 'Agregar'}</Button>
      </div>
    </section>
  );
}

function NameSection({ name }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(name), [name]);
  const save = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      await rpc('update_my_organization_name', { p_name: value });
      await refreshContext();
      toast('Nombre actualizado');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon"><Icon name="route" size={19} /></span>
        <div><h2>Tu ruta</h2></div>
      </header>
      <div class="inline-form">
        <Field label="Nombre de la ruta" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <Button variant="ghost" loading={busy} disabled={!value.trim() || value === name} onClick={save}>Guardar</Button>
      </div>
    </section>
  );
}

export function Ajustes() {
  const ctx = useStore(session, (s) => s.ctx);
  const orgId = ctx.organization.id;
  const settings = useQuery('admin:settings', () => q(supabase.from('settings').select('*').eq('organization_id', orgId).single()));

  return (
    <>
      <PageHeader title="Ajustes" />
      <div class="settings-grid">
        <CapitalSection />
        <NameSection name={ctx.organization.name} />
        {settings.data ? <LoanSection settings={settings.data} orgId={orgId} key={'l' + settings.data.updated_at} /> : <Skeleton h={220} r={26} />}
        {settings.data ? <MoraSection settings={settings.data} orgId={orgId} key={settings.data.updated_at} /> : <Skeleton h={220} r={26} />}
        <AccountsSection orgId={orgId} />
      </div>
    </>
  );
}
