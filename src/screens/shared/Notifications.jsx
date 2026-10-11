import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { timeAgo } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Button, Empty, ErrorState, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { refreshUnread, useNotifVersion } from './notifications.js';
import { pushStatus } from '../../lib/push.js';
import { Link } from '../../lib/router.jsx';

// Invitación a recibir estas alertas también en el teléfono
function PushInvite() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    pushStatus().then(setStatus).catch(() => {});
  }, []);
  if (!status || status === 'on' || status === 'unsupported') return null;
  return (
    <Link href="/perfil" class="push-invite" data-enter>
      <span class="row-icon tone-bg-lime"><Icon name="bell" size={19} /></span>
      <div class="row-main">
        <span class="row-title">Recibe estas alertas en tu teléfono</span>
        <span class="row-sub">Actívalas en tu perfil, aunque la app esté cerrada.</span>
      </div>
      <Icon name="chevron" size={18} class="row-chevron" />
    </Link>
  );
}

// Ícono y color según el tipo de notificación
const KIND = {
  transferencia_pendiente: ['transfer', 'lav'],
  transferencia_rechazada: ['alert', 'coral'],
  cuotas_no_pagadas: ['alert', 'amber'],
  cuotas_no_pagadas_ruta: ['alert', 'amber'],
  prestamo_en_mora: ['alert', 'coral'],
  prestamos_importados: ['upload', 'lime'],
  recargo_mora: ['alert', 'coral'],
  capital_asignado: ['wallet', 'lime'],
  cliente_reasignado_entrada: ['users', 'lime'],
  cliente_reasignado_salida: ['users', 'lav'],
  gasto_cobrador: ['cash', 'lav'],
  cuadre_cerrado: ['check', 'lime'],
  suscripcion_por_vencer: ['calendar', 'amber'],
  suscripcion_vencida: ['lock', 'coral'],
  solo_lectura: ['lock', 'coral'],
  suscripcion_renovada: ['check', 'lime'],
  ruta_vencida: ['calendar', 'amber'],
  ruta_solo_lectura: ['lock', 'coral']
};

export function Notifications() {
  const userId = useStore(session, (s) => s.user?.id);
  const version = useNotifVersion();
  const { data, loading, error, reload } = useQuery(`notif:${userId}:${version}`, () =>
    q(supabase.from('notifications').select('id,type,title,body,read_at,created_at').eq('recipient_id', userId).order('created_at', { ascending: false }).limit(60))
  );

  const markAll = async () => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', userId).is('read_at', null);
    refreshUnread(userId);
  };

  const unread = (data || []).some((n) => !n.read_at);

  return (
    <>
      <PageHeader title="Notificaciones" back="/" actions={unread && <Button variant="ghost" size="sm" icon="check" onClick={markAll}>Marcar leídas</Button>} />
      <PushInvite />
      {loading && !data ? (
        <div class="list-card">{[1, 2, 3, 4].map(() => <div class="row"><Skeleton h={40} w={40} r={14} /><div class="row-main"><Skeleton w="60%" /><Skeleton w="85%" h={12} /></div></div>)}</div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data.length ? (
        <Empty icon="bell" title="Estás al día">Aquí verás alertas de cobros, transferencias y tu suscripción.</Empty>
      ) : (
        <div class="list-card" data-enter>
          {data.map((n) => {
            const [icon, tone] = KIND[n.type] || ['bell', 'lav'];
            return (
              <div class={`row ${n.read_at ? '' : 'is-unread'}`}>
                <span class={`row-icon tone-bg-${tone}`}><Icon name={icon} size={19} /></span>
                <div class="row-main">
                  <span class="row-title">{n.title}</span>
                  {n.body && <span class="row-sub">{n.body}</span>}
                </div>
                <span class="row-meta">{timeAgo(n.created_at)}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
