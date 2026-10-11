import { cop } from '../../lib/money.js';
import { Avatar, StatusDot, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { STATE } from './data.js';

// Lista de clientes de la ruta con su estado (al día, atrasado, en mora...)
export function RouteRow({ item, onClick }) {
  const s = STATE[item.state];
  const amount = item.state === 'pagado' ? item.paidToday : Math.max(item.daily, item.owedToDate);
  return (
    <button type="button" class="route-row" onClick={() => onClick(item)} data-enter>
      <Avatar name={item.client.full_name} tone="paper" size={44} />
      <div class="route-main">
        <span class="route-name">{item.client.full_name}</span>
        <span class="route-sub">
          <StatusDot tone={s.tone} />
          <span class="route-state">{s.label}</span>
          {item.client.address ? <span class="route-addr">{item.client.address}</span> : null}
        </span>
      </div>
      <div class={`route-amount num ${item.state === 'pagado' ? 'is-paid' : ''}`}>
        {item.state === 'pagado' ? '+' : ''}
        {cop(amount)}
        {item.overdue > 0 && item.state !== 'pagado' && <span class="route-overdue">Atraso {cop(item.overdue)}</span>}
      </div>
      <Icon name="chevron" size={18} class="route-chevron" />
    </button>
  );
}

export function RouteSkeleton({ rows = 4 }) {
  return Array.from({ length: rows }, () => (
    <div class="route-row">
      <Skeleton w={44} h={44} r={22} class="sk-paper" />
      <div class="route-main">
        <Skeleton w="55%" h={14} class="sk-paper" />
        <Skeleton w="35%" h={12} class="sk-paper" />
      </div>
      <Skeleton w={70} h={16} class="sk-paper" />
    </div>
  ));
}
