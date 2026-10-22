import { bankRoute } from "@/lib/bank/http";
import { learningStats } from "@/lib/grading/stats";
import { enrolments, membersOf, submissionsOf, submissionsOfClass, teacherGroup } from "@/lib/grading/store";

/**
 * Everything the marking page starts from: my students (each with their record), the record of
 * all of them, my invite code, and the teachers I joined as a student.
 */
export const GET = bankRoute(async ({ owner }) => {
  const group = teacherGroup(owner);
  return {
    teacher: group
      ? {
          name: group.name,
          invite_code: group.join_code,
          students: membersOf(group.id).map(({ user_id, ...m }) => ({ ...m, linked: !!user_id, stats: learningStats(submissionsOf(m.id), { recent: 10 }) })),
          stats: learningStats(submissionsOfClass(group.id)),
        }
      : null,
    enrolled: enrolments(owner).map(({ cls, member }) => ({ teacher: cls.name, member: { id: member.id, name: member.name } })),
  };
});
