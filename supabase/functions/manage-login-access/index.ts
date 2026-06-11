import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type FamilyRow = {
  id: string;
  carpool_number: number;
};

type AppUserRow = {
  id: string;
  role: string;
  family_id: string | null;
};

type ManagePayload = {
  action?: string;
  parentPassword?: string;
  classroomUsername?: string;
  classroomPassword?: string;
};

type AuthUser = {
  id: string;
  email?: string;
};

const DEFAULT_AUTH_EMAIL_DOMAIN = "auth.tsgw-carpool.local";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function cleanText(value: unknown, maxLength = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function passwordValue(value: unknown) {
  return String(value || "").slice(0, 200);
}

function authEmailDomain() {
  return cleanText(Deno.env.get("AUTH_EMAIL_DOMAIN"), 120) || DEFAULT_AUTH_EMAIL_DOMAIN;
}

function parentEmailForFamilyNumber(carpoolNumber: number) {
  return `parent-${carpoolNumber}@${authEmailDomain()}`.toLowerCase();
}

function normalizeClassroomUsername(value: unknown) {
  return cleanText(value, 80)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function classroomEmailForUsername(username: string) {
  return `classroom-${username}@${authEmailDomain()}`.toLowerCase();
}

function validatePassword(password: string, label: string) {
  if (!password || password.length < 6) {
    throw new Error(`${label} must be at least 6 characters.`);
  }
}

function bearerToken(req: Request) {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function requireAdmin(req: Request, supabase: ReturnType<typeof createClient>) {
  const token = bearerToken(req);
  if (!token) throw new Error("Missing admin session.");

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) throw new Error("Invalid admin session.");

  const { data: profile, error: profileError } = await supabase
    .from("app_users")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile || profile.role !== "admin") {
    throw new Error("Admin access required.");
  }

  return userData.user;
}

async function listAllAuthUsers(supabase: ReturnType<typeof createClient>) {
  const users: AuthUser[] = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const batch = ((data?.users || []) as AuthUser[]);
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  return users;
}

function usersByEmail(users: AuthUser[]) {
  const map = new Map<string, AuthUser>();
  users.forEach((user) => {
    const email = cleanText(user.email).toLowerCase();
    if (email) map.set(email, user);
  });
  return map;
}

async function assignParentProfile(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  familyId: string
) {
  await supabase
    .from("app_users")
    .delete()
    .eq("role", "parent")
    .eq("family_id", familyId)
    .neq("id", userId);

  const { error } = await supabase
    .from("app_users")
    .upsert({ id: userId, role: "parent", family_id: familyId }, { onConflict: "id" });
  if (error) throw error;
}

async function assignClassroomProfile(
  supabase: ReturnType<typeof createClient>,
  userId: string
) {
  await supabase
    .from("app_users")
    .delete()
    .eq("role", "classroom")
    .neq("id", userId);

  const { error } = await supabase
    .from("app_users")
    .upsert({ id: userId, role: "classroom", family_id: null }, { onConflict: "id" });
  if (error) throw error;
}

async function syncParentLogins(
  supabase: ReturnType<typeof createClient>,
  parentPassword: string
) {
  validatePassword(parentPassword, "Parent password");

  const [{ data: familiesData, error: familiesError }, { data: appUsersData, error: appUsersError }, authUsers] =
    await Promise.all([
      supabase.from("families").select("id,carpool_number").order("carpool_number", { ascending: true }),
      supabase.from("app_users").select("id,role,family_id").eq("role", "parent"),
      listAllAuthUsers(supabase)
    ]);

  if (familiesError) throw familiesError;
  if (appUsersError) throw appUsersError;

  const families = (familiesData || []) as FamilyRow[];
  const appUsersByFamily = new Map(
    ((appUsersData || []) as AppUserRow[])
      .filter((row) => row.family_id)
      .map((row) => [row.family_id as string, row])
  );
  const authByEmail = usersByEmail(authUsers);

  let created = 0;
  let updated = 0;
  const failures: Array<{ carpool_number: number; error: string }> = [];

  for (const family of families) {
    const email = parentEmailForFamilyNumber(family.carpool_number);
    const existingProfile = appUsersByFamily.get(family.id);
    const existingByEmail = authByEmail.get(email);

    try {
      let userId = existingProfile?.id || existingByEmail?.id || "";
      const attributes = {
        email,
        password: parentPassword,
        email_confirm: true,
        user_metadata: {
          role: "parent",
          family_id: family.id,
          carpool_number: family.carpool_number
        },
        app_metadata: {
          role: "parent",
          family_id: family.id
        }
      };

      if (userId) {
        const { data, error } = await supabase.auth.admin.updateUserById(userId, attributes);
        if (error) throw error;
        userId = data.user?.id || userId;
        updated += 1;
      } else {
        const { data, error } = await supabase.auth.admin.createUser(attributes);
        if (error) throw error;
        userId = data.user?.id || "";
        created += 1;
      }

      if (!userId) throw new Error("Auth user was not returned.");
      await assignParentProfile(supabase, userId, family.id);
    } catch (error) {
      failures.push({
        carpool_number: family.carpool_number,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ok: failures.length === 0,
    action: "sync-parent-logins",
    total_families: families.length,
    created,
    updated,
    failed: failures.length,
    failures
  };
}

async function setClassroomLogin(
  supabase: ReturnType<typeof createClient>,
  classroomUsername: string,
  classroomPassword: string
) {
  const username = normalizeClassroomUsername(classroomUsername || "classroom");
  if (!username) throw new Error("Classroom username is required.");
  validatePassword(classroomPassword, "Classroom password");

  const email = classroomEmailForUsername(username);
  const [{ data: classroomProfiles, error: profilesError }, authUsers] = await Promise.all([
    supabase.from("app_users").select("id,role,family_id").eq("role", "classroom").limit(1),
    listAllAuthUsers(supabase)
  ]);
  if (profilesError) throw profilesError;

  const existingProfile = ((classroomProfiles || []) as AppUserRow[])[0] || null;
  const existingByEmail = usersByEmail(authUsers).get(email);
  let userId = existingProfile?.id || existingByEmail?.id || "";

  const attributes = {
    email,
    password: classroomPassword,
    email_confirm: true,
    user_metadata: {
      role: "classroom",
      username
    },
    app_metadata: {
      role: "classroom"
    }
  };

  let created = false;
  if (userId) {
    const { data, error } = await supabase.auth.admin.updateUserById(userId, attributes);
    if (error) throw error;
    userId = data.user?.id || userId;
  } else {
    const { data, error } = await supabase.auth.admin.createUser(attributes);
    if (error) throw error;
    userId = data.user?.id || "";
    created = true;
  }

  if (!userId) throw new Error("Auth user was not returned.");
  await assignClassroomProfile(supabase, userId);

  return {
    ok: true,
    action: "set-classroom-login",
    username,
    created
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase service configuration" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  try {
    await requireAdmin(req, supabase);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }

  let payload: ManagePayload;
  try {
    payload = await req.json();
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  try {
    if (payload.action === "sync-parent-logins") {
      return jsonResponse(await syncParentLogins(supabase, passwordValue(payload.parentPassword)));
    }

    if (payload.action === "set-classroom-login") {
      return jsonResponse(await setClassroomLogin(
        supabase,
        cleanText(payload.classroomUsername || "classroom", 80),
        passwordValue(payload.classroomPassword)
      ));
    }

    return jsonResponse({ error: "Unknown login access action" }, 400);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
