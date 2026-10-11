import { useRef, useState } from 'preact/hooks';
import { canWrite } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q, rpc, message } from '../../lib/api.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { cop } from '../../lib/money.js';
import { todayISO } from '../../lib/dates.js';
import { writeXlsx, readXlsx, readCsv, excelDate, download } from '../../lib/xlsx.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Button, Pills } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { SuccessBurst } from '../../components/SuccessBurst.jsx';

// Acá el administrador sube los préstamos que ya tiene (Excel) para no crearlos uno por uno
const COLUMNS = [
  { key: 'cedula', label: 'Cédula *', width: 14, match: ['cedula', 'documento'] },
  { key: 'nombre', label: 'Nombre completo *', width: 26, match: ['nombre'] },
  { key: 'telefono', label: 'Teléfono', width: 14, match: ['telefono', 'celular'] },
  { key: 'barrio', label: 'Barrio *', width: 18, match: ['barrio'] },
  { key: 'direccion', label: 'Dirección o nota', width: 28, match: ['direccion', 'nota'] },
  { key: 'cobrador', label: 'Usuario del cobrador *', width: 20, match: ['cobrador', 'usuario'] },
  { key: 'monto', label: 'Monto prestado *', width: 16, match: ['monto', 'prestado', 'capital'] },
  { key: 'interes', label: 'Interés %', width: 11, match: ['interes'] },
  { key: 'frecuencia', label: 'Frecuencia (diario, quincenal o mensual)', width: 22, match: ['frecuencia'] },
  { key: 'fecha_prestamo', label: 'Fecha del préstamo * (AAAA-MM-DD)', width: 20, match: ['fechadelprestamo', 'fechaprestamo', 'fechainicio', 'fechadeinicio'] },
  { key: 'fecha_limite', label: 'Fecha límite (AAAA-MM-DD)', width: 18, match: ['fechalimite', 'fechafinal', 'vence'] },
  { key: 'cuotas', label: 'Número de cuotas', width: 12, match: ['cuotas'] },
  { key: 'pagado', label: 'Valor ya pagado', width: 16, match: ['pagado', 'abonado', 'cancelado'] }
];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const FREQ = { diario: 'diario', diaria: 'diario', quincenal: 'quincenal', quincena: 'quincenal', mensual: 'mensual', mes: 'mensual' };

function toMoney(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return Math.round(v);
  const digits = String(v).replace(/[^\d]/g, '');
  return digits ? Number(digits) : NaN;
}

function toDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return excelDate(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'x';
}

const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d + 'T12:00:00').getTime());

// Convierte las filas del archivo en préstamos y revisa los datos obligatorios
function toLoans(rows, users) {
  const head = rows.findIndex((r) => r.some((c) => norm(c).includes('cedula')));
  if (head < 0) throw new Error('No encontramos la columna "Cédula". Usa la plantilla.');
  const map = {};
  rows[head].forEach((h, i) => {
    const n = norm(h);
    const col = COLUMNS.find((c) => !Object.values(map).includes(c.key) && c.match.some((m) => n.includes(m)));
    if (col) map[i] = col.key;
  });
  const out = [];
  rows.slice(head + 1).forEach((r, idx) => {
    if (!r.some((c) => String(c ?? '').trim() !== '')) return;
    const raw = {};
    Object.entries(map).forEach(([i, key]) => (raw[key] = r[i] ?? ''));
    const errors = [];
    const doc = String(raw.cedula ?? '').replace(/[^0-9A-Za-z]/g, '');
    const monto = toMoney(raw.monto);
    const pagado = toMoney(raw.pagado) ?? 0;
    const interesTxt = String(raw.interes ?? '').replace('%', '').replace(',', '.').trim();
    const interes = interesTxt === '' ? null : Number(interesTxt);
    const frecuencia = FREQ[norm(raw.frecuencia)] || (String(raw.frecuencia ?? '').trim() ? null : 'diario');
    const fecha_prestamo = toDate(raw.fecha_prestamo);
    const fecha_limite = toDate(raw.fecha_limite);
    const cuotasTxt = String(raw.cuotas ?? '').trim();
    const cuotas = cuotasTxt === '' ? null : Number(cuotasTxt);
    const cobrador = String(raw.cobrador ?? '').trim().toLowerCase();

    if (doc.length < 5) errors.push('cédula');
    if (!String(raw.nombre ?? '').trim()) errors.push('nombre');
    if (!String(raw.barrio ?? '').trim()) errors.push('barrio');
    if (!cobrador) errors.push('usuario del cobrador');
    else if (users && !users.has(cobrador)) errors.push(`el cobrador "${cobrador}" no existe`);
    if (!monto || Number.isNaN(monto) || monto <= 0) errors.push('monto');
    if (interes != null && (Number.isNaN(interes) || interes < 0)) errors.push('interés');
    if (!frecuencia) errors.push('frecuencia');
    if (!fecha_prestamo || !validDate(fecha_prestamo)) errors.push('fecha del préstamo');
    if (fecha_limite && !validDate(fecha_limite)) errors.push('fecha límite');
    else if (fecha_limite && fecha_prestamo && fecha_limite <= fecha_prestamo) errors.push('la fecha límite debe ser después del préstamo');
    if (cuotas != null && !(Number.isInteger(cuotas) && cuotas > 0 && cuotas <= 400)) errors.push('número de cuotas');
    if (!fecha_limite && cuotas == null) errors.push('fecha límite o número de cuotas');
    if (Number.isNaN(pagado) || pagado < 0) errors.push('valor pagado');

    out.push({
      line: head + idx + 2,
      data: {
        cedula: doc,
        nombre: String(raw.nombre ?? '').trim(),
        telefono: String(raw.telefono ?? '').trim(),
        barrio: String(raw.barrio ?? '').trim(),
        direccion: String(raw.direccion ?? '').trim(),
        cobrador,
        monto,
        interes,
        frecuencia,
        fecha_prestamo,
        fecha_limite: fecha_limite || null,
        cuotas: fecha_limite ? null : cuotas,
        pagado
      },
      error: errors.length ? `Revisa: ${errors.join(', ')}` : null
    });
  });
  return out;
}

async function sendRows(rows, dry) {
  const results = [];
  for (let i = 0; i < rows.length; i += 400) {
    const part = rows.slice(i, i + 400);
    const r = await rpc('import_loans', { p_rows: part.map((x) => x.data), p_dry_run: dry });
    r.rows.forEach((res, j) => results.push({ ...part[j], server: res }));
  }
  return results;
}

export function Importar() {
  const collectors = useQuery('admin:collectors-users', () => q(supabase.from('profiles').select('id,full_name,username').eq('role', 'cobrador').eq('is_active', true).order('full_name')));
  const settings = useQuery('admin:settings-import', () => q(supabase.from('settings').select('default_interest_rate').maybeSingle()));
  const input = useRef(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('todas');
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(null);

  const users = collectors.data ? new Set(collectors.data.map((c) => (c.username || '').toLowerCase())) : null;

  // Plantilla con un ejemplo, las instrucciones y los usuarios de los cobradores
  const template = () => {
    const cols = COLUMNS;
    const first = (collectors.data || [])[0]?.username || 'usuario';
    const rate = Number(settings.data?.default_interest_rate ?? 20);
    const blob = writeXlsx([
      {
        name: 'Prestamos',
        widths: cols.map((c) => c.width),
        rows: [
          cols.map((c) => c.label),
          ['1234567890', 'María Pérez', '3001234567', 'La Victoria', 'Cra 8 #45-12, tienda azul', first, 200000, rate, 'diario', todayISO(), '', 24, 50000],
          ['9876543210', 'Carlos Gómez', '3109876543', 'Rebolo', 'Frente al parque', first, 500000, rate, 'quincenal', todayISO(), '', 4, 0]
        ]
      },
      {
        name: 'Instrucciones',
        header: false,
        widths: [100],
        rows: [
          ['Cómo llenar la plantilla'],
          ['1. Una fila por préstamo. Borra las 2 filas de ejemplo antes de subir el archivo.'],
          ['2. Obligatorios: Cédula, Nombre, Barrio, Usuario del cobrador, Monto, Fecha del préstamo y (Fecha límite o Número de cuotas).'],
          ['3. Usuario del cobrador: el usuario con el que entra a la app. Mira la hoja "Cobradores". El cobrador debe estar creado antes de importar.'],
          ['4. Dirección: puedes escribir la dirección o solo una nota para ubicar al cliente. La ubicación en el mapa se agrega después.'],
          [`5. Interés: si lo dejas vacío se usa el de tu configuración (${rate}%). Es el mismo porcentaje para diario, quincenal o mensual.`],
          ['6. Frecuencia: diario, quincenal (días 15 y 30) o mensual. Si la dejas vacía se toma diario.'],
          ['7. Fechas en formato AAAA-MM-DD (ej. 2026-10-01) o DD/MM/AAAA.'],
          ['8. Valor ya pagado: lo que el cliente ya te abonó antes de usar la app. Se marcan como pagadas las primeras cuotas y no se suma a la caja del cobrador.'],
          ['9. Los préstamos importados no descuentan capital del cobrador; solo se suman al capital en la calle.'],
          ['10. Si la cédula ya existe en tu ruta, se usa ese mismo cliente.']
        ]
      },
      {
        name: 'Cobradores',
        widths: [30, 24],
        rows: [['Nombre', 'Usuario (cópialo tal cual)'], ...(collectors.data || []).map((c) => [c.full_name, c.username])]
      }
    ]);
    download(blob, 'plantilla-prestamos.xlsx');
  };

  const pick = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setRows(null);
    setBusy('read');
    try {
      const data = /\.csv$/i.test(file.name) ? readCsv(await file.text()) : await readXlsx(file);
      const loans = toLoans(data, users);
      if (!loans.length) throw new Error('El archivo no tiene filas con préstamos.');
      setFilter('todas');
      // Revisión en el servidor sin guardar nada (modo prueba)
      const valid = loans.filter((l) => !l.error);
      if (valid.length && navigator.onLine) {
        const checked = await sendRows(valid, true);
        const byLine = new Map(checked.map((c) => [c.line, c]));
        setRows(loans.map((l) => byLine.get(l.line) || l));
      } else setRows(loans);
    } catch (err) {
      toast(message(err), 'error');
      setFileName('');
    } finally {
      setBusy('');
      if (input.current) input.current.value = '';
    }
  };

  const ok = (rows || []).filter((r) => !r.error && r.server?.ok !== false);
  const bad = (rows || []).filter((r) => r.error || r.server?.ok === false);
  const shown = filter === 'errores' ? bad : filter === 'listas' ? ok : rows || [];
  const totalBalance = ok.reduce((s, r) => s + Number(r.server?.balance ?? 0), 0);

  const run = async () => {
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (!ok.length) return;
    setBusy('save');
    try {
      const res = await sendRows(ok, false);
      const saved = res.filter((r) => r.server?.ok).length;
      const failed = res.filter((r) => !r.server?.ok);
      invalidate('clients:');
      invalidate('admin:');
      invalidate('route:');
      if (failed.length) {
        setRows(failed);
        setFilter('todas');
        toast(`Se importaron ${saved}. ${failed.length} no se pudieron guardar, revísalas.`, 'error');
      } else setDone(saved);
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy('');
    }
  };

  if (done != null)
    return (
      <>
        <PageHeader title="Importar préstamos" back="/clientes" />
        <SuccessBurst
          amount={totalBalance}
          title={`${done} préstamo${done === 1 ? '' : 's'} importado${done === 1 ? '' : 's'}`}
          detail="Saldo por cobrar. Ya aparecen en la ruta de cada cobrador."
          onDone={() => {
            setDone(null);
            setRows(null);
            setFileName('');
          }}
        />
      </>
    );

  return (
    <>
      <PageHeader eyebrow="Clientes" title="Importar préstamos" back="/clientes" />
      <div class="import-steps">
        <section class="settings-card" data-enter>
          <header>
            <span class="row-icon tone-bg-lime"><Icon name="download" size={19} /></span>
            <div>
              <h2>1. Descarga la plantilla</h2>
              <p class="muted">Un Excel con las columnas, dos ejemplos y los usuarios de tus cobradores.</p>
            </div>
          </header>
          <Button variant="ghost" icon="download" onClick={template} disabled={collectors.loading && !collectors.data}>Descargar plantilla</Button>
          {collectors.data && !collectors.data.length && <p class="field-hint">Primero crea tus cobradores: cada préstamo debe quedar asignado a uno.</p>}
        </section>

        <section class="settings-card" data-enter>
          <header>
            <span class="row-icon tone-bg-lav"><Icon name="upload" size={19} /></span>
            <div>
              <h2>2. Sube el archivo lleno</h2>
              <p class="muted">Revisamos cada fila antes de guardar. Nada se guarda hasta que confirmes.</p>
            </div>
          </header>
          <label class={`drop-zone ${busy === 'read' ? 'is-busy' : ''}`}>
            <input ref={input} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => pick(e.currentTarget.files[0])} />
            <Icon name={busy === 'read' ? 'sync' : 'file'} size={26} class={busy === 'read' ? 'spin' : ''} />
            <b>{busy === 'read' ? 'Revisando el archivo…' : fileName || 'Toca para elegir el Excel'}</b>
            <span class="muted">Archivos .xlsx o .csv</span>
          </label>
        </section>
      </div>

      {rows && (
        <>
          <div class="import-summary" data-enter>
            <div><span>Listas</span><b class="num">{ok.length}</b></div>
            <div class={bad.length ? 'is-bad' : ''}><span>Con errores</span><b class="num">{bad.length}</b></div>
            <div><span>Saldo a cobrar</span><b class="num">{cop(totalBalance)}</b></div>
          </div>
          <div class="toolbar" data-enter>
            <Pills label="Filtrar filas" value={filter} onChange={setFilter} options={[{ value: 'todas', label: 'Todas', count: rows.length }, { value: 'listas', label: 'Listas', count: ok.length }, { value: 'errores', label: 'Con errores', count: bad.length }]} />
          </div>
          <section class="paper-panel paper-flat" data-enter>
            <div class="route-list">
              {shown.map((r) => {
                const err = r.error || (r.server?.ok === false ? r.server.error : null);
                const d = r.data;
                return (
                  <div class="route-row import-row">
                    <span class={`import-line num ${err ? 'is-bad' : ''}`}>{r.line}</span>
                    <div class="route-main">
                      <span class="route-name">{d.nombre || 'Sin nombre'}</span>
                      <span class="route-sub import-sub">
                        {err ? (
                          <span class="import-error">{err}</span>
                        ) : (
                          <span>
                            {d.cobrador} · {d.frecuencia} · {d.cuotas ? `${d.cuotas} cuotas` : `hasta ${d.fecha_limite}`}
                            {d.pagado ? ` · pagado ${cop(d.pagado)}` : ''}
                          </span>
                        )}
                      </span>
                    </div>
                    <div class="route-amount num">
                      {cop(d.monto || 0)}
                      {r.server?.ok && <span class="route-overdue import-balance">Debe {cop(r.server.balance)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <div class="import-actions" data-enter>
            {bad.length > 0 && <p class="muted">Las filas con errores no se importan. Corrígelas en el Excel y vuelve a subirlo.</p>}
            <Button size="lg" class="btn-block" icon="check" loading={busy === 'save'} disabled={!ok.length} onClick={run}>
              Importar {ok.length} préstamo{ok.length === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
