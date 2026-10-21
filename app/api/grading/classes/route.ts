import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { classesTaughtBy, createClass, enrolments, membersOf, submissionsOfClass } from "@/lib/grading/store";

/** The caller's classes: those they teach (with counts) and those they joined as a student. */
export const GET = bankRoute(async ({ owner }) => ({
  teaching: classesTaughtBy(owner).map((c) => ({ ...c, members: membersOf(c.id).length, submissions: submissionsOfClass(c.id).length })),
  enrolled: enrolments(owner).map(({ cls, member }) => ({ class: { id: cls.id, name: cls.name }, member })),
}));

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const POST = bankRoute(async ({ req, owner }) => ({ class: createClass(owner, createSchema.parse(await jsonBody(req)).name) }));
