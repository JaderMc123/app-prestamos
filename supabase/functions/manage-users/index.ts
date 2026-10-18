import { createClient } from "npm:@supabase/supabase-js@2";

// Correo interno: los usuarios inician sesión con código de ruta + usuario.
const EMAIL_DOMAIN = "cobros.app";
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const CODE_RE = /^[a-z0-9-]{3,20}$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

const emailFor = (username: string, code: string) => `${username}@${code}.${EMAIL_DOMAIN}`;

function cleanUsername(u: unknown) {
  const v = String(u ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(v)) throw new AppError("USUARIO_INVALIDO", "El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo.");
  return v;
}
function checkPassword(p: unknown) {
  const v = String(p ?? "");
  if (v.length < 8) throw new AppError("CONTRASENA_INVALIDA", "La contraseña debe tener al menos 8 caracteres.");
  return v;
}
function requireText(v: unknown, field: string) {
  const s = String(v ?? "").trim();
  if (!s) throw new AppError("DATO_REQUERIDO", `Falta el campo ${field}.`);
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODO_NO_PERMITIDO" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let meId: string | null = null;
  let meOrg: string | null = null;
  let action = "";

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) throw new AppError("NO_AUTENTICADO", "Sesión inválida.", 401);

    const { data: me } = await admin.from("profiles")
      .select("id, role, organization_id, is_active").eq("id", auth.user.id).single();
    if (!me || !me.is_active) throw new AppError("NO_AUTORIZADO", "Usuario no autorizado.", 403);
    meId = me.id; meOrg = me.organization_id;
    const isSuper = me.role === "super_admin";
    const isAdmin = me.role === "admin";

    const body = await req.json().catch(() => ({}));
    action = String(body.action ?? "");

    // El admin solo puede gestionar usuarios si su ruta permite escritura
    const assertAdminCanWrite = async () => {
      const { data: level } = await admin.rpc("org_access", { p_org: me.organization_id });
      if (level !== "full" && level !== "grace") {
        throw new AppError("SUSCRIPCION_VENCIDA", "No se puede realizar ninguna operación hasta que se pague la suscripción.", 403);
      }
    };

    const audit = async (org: string | null, act: string, entity: string, entityId: string | null) => {
      await admin.from("audit_logs").insert({ organization_id: org, actor_id: me.id, action: act, entity, entity_id: entityId });
    };

    // Carga el usuario objetivo y valida que quien llama pueda gestionarlo
    const loadTarget = async (userId: string) => {
      const { data: t } = await admin.from("profiles")
        .select("id, role, organization_id").eq("id", requireText(userId, "user_id")).single();
      if (!t) throw new AppError("USUARIO_NO_ENCONTRADO", "Usuario no encontrado.", 404);
      if (isSuper) return t;
      if (isAdmin && t.role === "cobrador" && t.organization_id === me.organization_id) {
        await assertAdminCanWrite();
        return t;
      }
      throw new AppError("NO_AUTORIZADO", "No puedes gestionar este usuario.", 403);
    };

    switch (action) {
      // ---------- Súper admin ----------
      case "create_super_admin": {
        if (!isSuper) throw new AppError("NO_AUTORIZADO", "Solo el súper admin.", 403);
        const username = cleanUsername(body.username);
        const { data, error } = await admin.auth.admin.createUser({
          email: emailFor(username, "sistema"),
          password: checkPassword(body.password),
          email_confirm: true,
          app_metadata: { role: "super_admin", username },
          user_metadata: { full_name: requireText(body.full_name, "full_name") },
        });
        if (error) throw new AppError("ERROR_CREAR_USUARIO", error.message.includes("already") ? "Ese usuario ya existe." : error.message);
        await audit(null, "create", "super_admin", data.user.id);
        return json({ user_id: data.user.id });
      }

      case "create_admin": {
        if (!isSuper) throw new AppError("NO_AUTORIZADO", "Solo el súper admin.", 403);
        const o = body.organization ?? {};
        const code = String(o.code ?? "").trim().toLowerCase();
        if (!CODE_RE.test(code) || code === "sistema") {
          throw new AppError("CODIGO_INVALIDO", "El código de ruta debe tener de 3 a 20 caracteres: letras, números o guion.");
        }
        const username = cleanUsername(body.username);
        const password = checkPassword(body.password);
        const fullName = requireText(body.full_name, "full_name");

        const { data: settingsRow } = await admin.from("platform_settings").select("default_subscription_price").single();
        const endsAt = o.subscription_ends_at ?? (() => {
          const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10);
        })();

        const { data: org, error: orgErr } = await admin.from("organizations").insert({
          name: requireText(o.name, "organization.name"),
          code,
          subscription_price: o.subscription_price ?? settingsRow?.default_subscription_price ?? 0,
          subscription_exempt: !!o.subscription_exempt,
          discount_type: o.discount_type ?? null,
          discount_value: o.discount_value ?? 0,
          discount_reason: o.discount_reason ?? null,
          subscription_ends_at: o.no_expiration ? null : endsAt,
        }).select("id").single();
        if (orgErr) throw new AppError("ERROR_CREAR_RUTA", orgErr.code === "23505" ? "Ese código de ruta ya existe." : orgErr.message);

        await admin.from("settings").insert({ organization_id: org.id });

        const { data, error } = await admin.auth.admin.createUser({
          email: emailFor(username, code),
          password,
          email_confirm: true,
          app_metadata: { role: "admin", organization_id: org.id, username },
          user_metadata: { full_name: fullName, phone: body.phone ?? null },
        });
        if (error) {
          await admin.from("organizations").delete().eq("id", org.id);
          throw new AppError("ERROR_CREAR_USUARIO", error.message);
        }
        await audit(org.id, "create", "admin", data.user.id);
        return json({ organization_id: org.id, user_id: data.user.id });
      }

      // ---------- Admin (o súper admin) ----------
      case "create_collector": {
        if (!isSuper && !isAdmin) throw new AppError("NO_AUTORIZADO", "Solo administradores.", 403);
        const orgId = isSuper ? requireText(body.organization_id, "organization_id") : me.organization_id;
        if (isAdmin) await assertAdminCanWrite();
        const { data: org } = await admin.from("organizations").select("id, code").eq("id", orgId).single();
        if (!org) throw new AppError("RUTA_NO_ENCONTRADA", "Ruta no encontrada.", 404);
        const username = cleanUsername(body.username);
        const { data, error } = await admin.auth.admin.createUser({
          email: emailFor(username, org.code),
          password: checkPassword(body.password),
          email_confirm: true,
          app_metadata: { role: "cobrador", organization_id: org.id, username },
          user_metadata: { full_name: requireText(body.full_name, "full_name"), phone: body.phone ?? null },
        });
        if (error) throw new AppError("ERROR_CREAR_USUARIO", error.message.includes("already") ? "Ese usuario ya existe en esta ruta." : error.message);
        await audit(org.id, "create", "cobrador", data.user.id);
        return json({ user_id: data.user.id });
      }

      case "reset_password": {
        const t = await loadTarget(body.user_id);
        const { error } = await admin.auth.admin.updateUserById(t.id, { password: checkPassword(body.password) });
        if (error) throw new AppError("ERROR_CONTRASENA", error.message);
        await audit(t.organization_id, "reset_password", "profiles", t.id);
        return json({ ok: true });
      }

      case "set_active": {
        const t = await loadTarget(body.user_id);
        if (t.id === me.id) throw new AppError("NO_PERMITIDO", "No puedes desactivarte a ti mismo.");
        const active = !!body.active;
        const { error } = await admin.auth.admin.updateUserById(t.id, { ban_duration: active ? "none" : "876000h" });
        if (error) throw new AppError("ERROR_ESTADO", error.message);
        await admin.from("profiles").update({ is_active: active }).eq("id", t.id);
        await audit(t.organization_id, active ? "activate" : "deactivate", "profiles", t.id);
        return json({ ok: true });
      }

      default:
        throw new AppError("ACCION_INVALIDA", "Acción no reconocida.");
    }
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError("ERROR_INTERNO", String((e as Error)?.message ?? e), 500);
    if (err.status >= 500 || err.code.startsWith("ERROR_")) {
      await admin.from("error_logs").insert({
        organization_id: meOrg, user_id: meId, source: "edge", level: "error",
        message: `${err.code}: ${err.message}`, context: { action },
      }).then(() => {}, () => {});
    }
    return json({ error: err.code, message: err.message }, err.status);
  }
});
