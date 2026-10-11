import { useRef, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { press } from '../lib/motion.js';
import { haptic } from '../lib/native.js';

// Acá están los componentes básicos de la interfaz: botones, campos, píldoras, etc.

export function Button({ variant = 'lime', size = 'md', icon, loading, disabled, children, onClick, class: cls = '', type = 'button', ...rest }) {
  const ref = useRef(null);
  const handle = (e) => {
    press(ref.current);
    haptic('light');
    onClick?.(e);
  };
  return (
    <button
      ref={ref}
      type={type}
      class={`btn btn-${variant} btn-${size} ${loading ? 'is-loading' : ''} ${cls}`}
      disabled={disabled || loading}
      onClick={handle}
      {...rest}
    >
      {loading ? <span class="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 18 : 20} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, badge, onClick, variant = 'ghost', class: cls = '' }) {
  const ref = useRef(null);
  return (
    <button
      ref={ref}
      type="button"
      class={`icon-btn icon-btn-${variant} ${cls}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        press(ref.current);
        onClick?.(e);
      }}
    >
      <Icon name={icon} size={20} />
      {badge ? <span class="dot-badge" aria-label={`${badge} sin leer`}>{badge > 9 ? '9+' : badge}</span> : null}
    </button>
  );
}

export function ActionPill({ icon, children, onClick, disabled }) {
  const ref = useRef(null);
  return (
    <button
      ref={ref}
      type="button"
      class="action-pill"
      disabled={disabled}
      onClick={(e) => {
        press(ref.current);
        haptic('light');
        onClick?.(e);
      }}
    >
      <span class="action-pill-icon"><Icon name={icon} size={18} /></span>
      <span>{children}</span>
    </button>
  );
}

export function Field({ label, hint, error, prefix, suffix, class: cls = '', inputRef, ...input }) {
  return (
    <label class={`field ${error ? 'has-error' : ''} ${cls}`}>
      <span class="field-label">{label}</span>
      <span class="field-box">
        {prefix && <span class="field-affix">{prefix}</span>}
        <input ref={inputRef} class="field-input" {...input} />
        {suffix}
      </span>
      {error ? <span class="field-error" role="alert">{error}</span> : hint ? <span class="field-hint">{hint}</span> : null}
    </label>
  );
}

export function PasswordField(props) {
  const [show, setShow] = useState(false);
  return (
    <Field
      {...props}
      type={show ? 'text' : 'password'}
      suffix={
        <button type="button" class="field-eye" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShow(!show)}>
          <Icon name={show ? 'eyeOff' : 'eye'} size={19} />
        </button>
      }
    />
  );
}

export function Select({ label, children, class: cls = '', ...rest }) {
  return (
    <label class={`field ${cls}`}>
      <span class="field-label">{label}</span>
      <span class="field-box">
        <select class="field-input" {...rest}>{children}</select>
        <Icon name="chevron" size={16} class="field-select-icon" />
      </span>
    </label>
  );
}

export function Pills({ options, value, onChange, label }) {
  return (
    <div class="pills" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === o.value}
          class={`pill ${value === o.value ? 'is-active' : ''}`}
          onClick={() => {
            haptic('light');
            onChange(o.value);
          }}
        >
          {o.label}
          {o.count != null && <span class="pill-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label class={`switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span class="switch-text">
        <span>{label}</span>
        {hint && <span class="field-hint">{hint}</span>}
      </span>
      <input type="checkbox" class="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function Avatar({ name = '', tone = 'dark', size = 44 }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span class={`avatar avatar-${tone}`} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">
      {initials || '·'}
    </span>
  );
}

export function StatusDot({ tone }) {
  return <span class={`status-dot tone-${tone}`} aria-hidden="true" />;
}

export function Skeleton({ h = 16, w = '100%', r = 10, class: cls = '' }) {
  return <span class={`skeleton ${cls}`} style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function Empty({ icon = 'check', title, children, action }) {
  return (
    <div class="empty" data-enter>
      <span class="empty-icon"><Icon name={icon} size={26} /></span>
      <h3>{title}</h3>
      {children && <p class="muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <Empty icon="alert" title="No se pudo cargar" action={onRetry && <Button variant="ghost" size="sm" icon="sync" onClick={onRetry}>Reintentar</Button>}>
      {error?.message || 'Revisa tu conexión e inténtalo de nuevo.'}
    </Empty>
  );
}

export function SectionHead({ title, action }) {
  return (
    <div class="section-head">
      <h2>{title}</h2>
      {action}
    </div>
  );
}
