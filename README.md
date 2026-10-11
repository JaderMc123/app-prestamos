# Cobros

App web (PWA) para gestionar préstamos y cobros diarios, con tres roles: súper admin, administrador (dueño de ruta) y cobrador. Se publica en Vercel y se empaqueta para Play Store y App Store con Capacitor.

## Tecnología

- Vite + Preact (código estilo React, más liviano para celulares de gama baja)
- GSAP para las animaciones
- Supabase: base de datos, inicio de sesión y funciones del servidor
- Capacitor para las apps de Android e iOS

## Ejecutar en tu computador

```bash
cp .env.example .env
npm install
npm run dev
```

## Publicar en Vercel

1. Importa este repositorio en Vercel (se detecta como proyecto Vite).
2. En **Settings → Environment Variables** agrega `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los valores de `.env.example`.
3. Despliega. El archivo `vercel.json` ya redirige todas las rutas a la app.

## Apps de Android e iOS

```bash
npm run build
npx cap add android   # solo la primera vez
npx cap add ios       # solo la primera vez, requiere Mac con Xcode
npm run cap:android   # abre Android Studio
npm run cap:ios       # abre Xcode
```

El nombre y el identificador de la app están en `capacitor.config.json`.

## Inicio de sesión

Cada usuario entra con **código de ruta + usuario + contraseña**. El súper admin usa el código `sistema`.

## Estructura

```
src/
  lib/          conexión a la base de datos, sesión, navegación, animaciones, cola sin señal
  components/   piezas de la interfaz (botones, paneles, gráfica, montos)
  screens/
    auth/       inicio de sesión
    cobrador/   inicio, ruta, cobro y gastos
    admin/      inicio, cobradores y ajustes
    super/      rutas, suscripciones, logs y plataforma
    shared/     perfil, notificaciones y pantalla de acceso bloqueado
  styles/       colores, tipografía y estructura de pantallas
```

La tipografía Manrope se incluye en `public/fonts` bajo licencia SIL Open Font License.
