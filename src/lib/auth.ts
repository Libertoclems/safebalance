import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { DealError } from "./deals";
import { isTestMode } from "./payments";

const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 30;
const OTP_MINUTES = 10;

function hash(value: string) {
  const pepper = process.env.AUTH_SECRET ?? "dev-secret-change-me";
  return crypto.createHmac("sha256", pepper).update(value).digest("hex");
}

/** Accept 0803..., 803..., 234803..., +234803... and return +234XXXXXXXXXX. */
export function normalizePhone(input: string) {
  const digits = input.replace(/\D/g, "");
  let local = digits;
  if (local.startsWith("234")) local = local.slice(3);
  if (local.startsWith("0")) local = local.slice(1);
  if (!/^[789]\d{9}$/.test(local)) throw new DealError("Enter a valid Nigerian phone number, like 0803 123 4567");
  return "+234" + local;
}

/** Create a 6-digit code. Returns the code only in test mode, so it can be shown on screen. */
export async function requestOtp(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  const recent = await prisma.otpCode.count({ where: { phone, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  if (recent >= 5) throw new DealError("Too many codes requested. Try again in an hour.");

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.otpCode.create({
    data: { phone, codeHash: hash(`${phone}:${code}`), expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000) },
  });
  // Production: send by SMS through a provider here.
  console.log(`[otp] ${phone} -> ${code}`);
  return { phone, testCode: isTestMode() ? code : undefined };
}

export async function verifyOtp(phoneInput: string, code: string, name?: string) {
  const phone = normalizePhone(phoneInput);
  const otp = await prisma.otpCode.findFirst({
    where: { phone, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw new DealError("That code has expired. Request a new one.");
  if (otp.attempts >= 5) throw new DealError("Too many wrong tries. Request a new code.");

  const given = Buffer.from(hash(`${phone}:${code.trim()}`));
  const ok = given.length === otp.codeHash.length && crypto.timingSafeEqual(given, Buffer.from(otp.codeHash));
  if (!ok) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new DealError("Wrong code. Check the code and try again.");
  }
  await prisma.otpCode.update({ where: { id: otp.id }, data: { used: true } });

  const isAdmin = isAdminPhone(phone);
  const user = await prisma.user.upsert({
    where: { phone },
    update: isAdmin ? { role: "admin" } : {},
    create: { phone, name: name?.trim() ?? "", role: isAdmin ? "admin" : "user" },
  });
  await startSession(user.id);
  return user;
}

function isAdminPhone(phone: string) {
  const admins = (process.env.ADMIN_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return admins.some((p) => {
    try { return normalizePhone(p) === phone; } catch { return false; }
  });
}

/**
 * Instant sign-in for testing: phone number and name, no code. Only works in
 * test mode (sandbox payments) AND with QUICK_LOGIN="on" in .env, so it can
 * never be active once real money is connected. Admin numbers always need
 * the code, so nobody can open the admin page this way.
 */
export function quickLoginEnabled() {
  // Forgiving about how it's typed in a hosting dashboard: on, "on", ON, true, yes, 1.
  const value = (process.env.QUICK_LOGIN ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  return isTestMode() && ["on", "true", "yes", "1"].includes(value);
}

export async function quickLogin(phoneInput: string, name: string) {
  if (!quickLoginEnabled()) throw new DealError("Quick sign-in is turned off");
  const phone = normalizePhone(phoneInput);
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (isAdminPhone(phone) || existing?.role === "admin") {
    throw new DealError("This number needs a sign-in code. Use \"Sign in with a code\" below.");
  }
  if (!existing && !name.trim()) throw new DealError("Enter your name");
  const user = existing ?? (await prisma.user.create({ data: { phone, name: name.trim() } }));
  if (existing && !existing.name && name.trim()) {
    await prisma.user.update({ where: { id: existing.id }, data: { name: name.trim() } });
  }
  await startSession(user.id);
  return user;
}

async function startSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { id: hash(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: SESSION_DAYS * 86400,
  });
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { id: hash(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

export async function requireUser(next = "/dashboard") {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { id: hash(token) } });
  jar.delete(SESSION_COOKIE);
}
