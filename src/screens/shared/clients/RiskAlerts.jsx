import { Icon } from '../../../components/Icon.jsx';

// Alertas al prestar: cliente riesgoso (mora en otras rutas) o marcado como "No prestar más"
export function RiskAlerts({ info }) {
  if (!info) return null;
  const c = info.client;
  return (
    <>
      {info.risky && (
        <div class="banner banner-coral" role="alert" data-enter>
          <Icon name="alert" size={18} />
          <span>Cuidado: este cliente tiene historial de mora en varios préstamos.</span>
        </div>
      )}
      {c?.blocked_by_admin && (
        <div class="banner banner-coral" role="alert" data-enter>
          <Icon name="lock" size={18} />
          <span>El administrador marcó este cliente como "No prestar más"{c.blocked_reason ? `: ${c.blocked_reason}` : ''}.</span>
        </div>
      )}
      {c?.blocked_by_me && (
        <div class="banner banner-amber" role="alert" data-enter>
          <Icon name="alert" size={18} />
          <span>Tú marcaste este cliente como "No prestar más".</span>
        </div>
      )}
    </>
  );
}
