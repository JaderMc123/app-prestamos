// Página pública con la política de tratamiento de datos personales (Ley 1581 de 2012)
export function TratamientoDatos() {
  return (
    <main class="legal">
      <div class="login-brand">
        <span class="brand-mark" aria-hidden="true" />
        <strong>Cobros</strong>
      </div>
      <h1>Política de tratamiento de datos personales</h1>
      <p>
        Al aceptar esta autorización, usted permite que el prestamista que le otorga el crédito (responsable del tratamiento) recolecte, almacene, use y
        actualice sus datos personales, en cumplimiento de la Ley 1581 de 2012 y el Decreto 1377 de 2013 de la República de Colombia.
      </p>
      <h2>Datos que se recogen</h2>
      <p>Nombre, número de cédula, teléfonos, barrio, dirección y ubicación, fotos del documento de identidad, foto suya o de su negocio, firma, referencias personales y el historial de sus préstamos y pagos.</p>
      <h2>Para qué se usan</h2>
      <ul>
        <li>Estudiar, otorgar y administrar los préstamos que usted solicite.</li>
        <li>Registrar los pagos, calcular saldos y enviarle recordatorios de cobro.</li>
        <li>Ubicar su domicilio o negocio para realizar los cobros.</li>
        <li>Verificar su identidad y prevenir fraudes.</li>
        <li>Advertir a otros prestamistas que usan esta plataforma sobre historial de mora, sin compartir sus datos personales.</li>
      </ul>
      <h2>Sus derechos</h2>
      <p>
        Usted puede conocer, actualizar, rectificar y solicitar la eliminación de sus datos, revocar esta autorización, pedir prueba de ella y presentar quejas ante la
        Superintendencia de Industria y Comercio. Para ejercerlos, comuníquese directamente con su prestamista.
      </p>
      <h2>Seguridad</h2>
      <p>Sus datos se guardan en servidores con acceso restringido. Las fotos de documentos son privadas y solo las ve el personal autorizado de su prestamista.</p>
      <p class="muted">Datos sensibles: usted no está obligado a autorizar el tratamiento de datos sensibles, como su fotografía o su firma.</p>
    </main>
  );
}
