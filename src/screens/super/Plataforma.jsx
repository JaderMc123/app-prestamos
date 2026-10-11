import { useEffect, useState } from 'preact/hooks';
import { supabase } from '../../lib/supabase.js';
import { q, manageUsers, message } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { parseCop } from '../../lib/money.js';
import { timeAgo } from '../../lib/dates.js';
import { suggestPassword } from '../../lib/password.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Avatar, Button, Field, PasswordField, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';

// Acá se configura la plataforma: días de gracia, precio por defecto, recordatorios y súper admins
function GeneralCard() {
  const s = useQuery('sa:platform', () => q(supabase.from('platform_settings').select('*').single()));
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => s.data && setF({ grace: String(s.data.grace_days), price: String(s.data.default_subscription_price), reminders: s.data.reminder_days.join(', '), risk: String(s.data.risk_overdue_threshold ?? 3) }), [s.data?.updated_at]);

  const save = async () => {
    const reminders = f.reminders.split(/[,\s]+/).map(Number).filter((n) => n > 0);
    setBusy(true);
    try {
      await q(supabase.from('platform_settings').update({ grace_days: Number(f.grace) || 0, default_subscription_price: parseCop(f.price), reminder_days: reminders, risk_overdue_threshold: Math.max(1, Number(f.risk) || 3) }).eq('id', true));
      toast('Configuración guardada');
      s.reload();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lime"><Icon name="settings" size={19} /></span>
        <div><h2>Suscripciones</h2><p class="muted">Valores que se aplican a todas las rutas, salvo que una tenga su propio ajuste.</p></div>
      </header>
      {!f ? (
        <Skeleton h={160} r={18} />
      ) : (
        <>
          <div class="form-row">
            <Field label="Días de gracia" hint="Siguen trabajando normal; después pasa a solo lectura." type="number" min="0" value={f.grace} onInput={(e) => setF({ ...f, grace: e.currentTarget.value })} />
            <Field label="Valor mensual por defecto" inputMode="numeric" prefix="$" value={parseCop(f.price) ? parseCop(f.price).toLocaleString('es-CO') : ''} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} />
          </div>
          <Field label="Recordar antes del vencimiento (días)" hint="Separados por coma. Ej. 5, 3, 1" value={f.reminders} onInput={(e) => setF({ ...f, reminders: e.currentTarget.value })} />
          <Field label="Alerta de cliente riesgoso" hint="Número de préstamos en mora (en cualquier ruta) desde el que se avisa al cobrador." type="number" min="1" value={f.risk} onInput={(e) => setF({ ...f, risk: e.currentTarget.value })} />
          <Button loading={busy} onClick={save}>Guardar cambios</Button>
        </>
      )}
    </section>
  );
}

function SuperAdminsCard() {
  const list = useQuery('sa:supers', () => q(supabase.from('profiles').select('id,full_name,username,is_active,last_seen_at').eq('role', 'super_admin').order('created_at')));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ full_name: '', username: '', password: suggestPassword() });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await manageUsers('create_super_admin', f);
      toast(`Súper admin creado. Entra con el código "sistema" y el usuario ${f.username}.`);
      setOpen(false);
      setF({ full_name: '', username: '', password: suggestPassword() });
      list.reload();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lav"><Icon name="key" size={19} /></span>
        <div><h2>Súper admins</h2><p class="muted">Inician sesión con el código de ruta "sistema".</p></div>
      </header>
      <div class="list-card list-flat">
        {(list.data || []).map((u) => (
          <div class="row">
            <Avatar name={u.full_name} tone="lime" size={40} />
            <div class="row-main"><span class="row-title">{u.full_name}</span><span class="row-sub">{u.username}, {timeAgo(u.last_seen_at).toLowerCase()}</span></div>
          </div>
        ))}
      </div>
      <Button variant="ghost" icon="plus" onClick={() => setOpen(true)}>Agregar súper admin</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nuevo súper admin" subtitle="Tendrá acceso a toda la plataforma.">
        <form class="form" onSubmit={submit}>
          <div data-enter><Field label="Nombre completo" value={f.full_name} onInput={(e) => setF({ ...f, full_name: e.currentTarget.value })} /></div>
          <div data-enter><Field label="Usuario" value={f.username} onInput={(e) => setF({ ...f, username: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} autocapitalize="none" /></div>
          <div data-enter><PasswordField label="Contraseña inicial" value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></div>
          <Button type="submit" size="lg" loading={busy} class="btn-block">Crear súper admin</Button>
        </form>
      </Sheet>
    </section>
  );
}

export function Plataforma() {
  return (
    <>
      <PageHeader title="Plataforma" />
      <div class="settings-grid">
        <GeneralCard />
        <SuperAdminsCard />
      </div>
    </>
  );
}
