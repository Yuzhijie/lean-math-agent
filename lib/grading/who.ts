/** How a teacher is shown to their students: their account name or email, else "Teacher". */
import { lt } from "../llm/output-locale";

export async function callerDisplayName(): Promise<string> {
  try {
    const [{ getServerSession }, { authOptions }] = await Promise.all([import("next-auth"), import("../auth")]);
    const user = (await getServerSession(authOptions))?.user as { name?: string | null; email?: string | null } | undefined;
    const name = user?.name?.trim() || user?.email?.split("@")[0]?.trim();
    if (name) return name.slice(0, 100);
  } catch {
    // auth not configured
  }
  return lt("老师", "Teacher");
}
