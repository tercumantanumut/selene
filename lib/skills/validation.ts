import { z } from "zod";

const skillStatusSchema = z.enum(["draft", "active", "archived"]);
const skillSourceTypeSchema = z.enum(["conversation", "manual", "template", "catalog"]);

const skillInputParameterSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["string", "number", "boolean"]).optional().default("string"),
  description: z.string().max(1000).optional(),
  required: z.boolean().optional().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const createSkillSchema = z.object({
  characterId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(10000).optional(),
  icon: z.string().max(20).optional(),
  promptTemplate: z.string().min(1).max(400000),
  inputParameters: z.array(skillInputParameterSchema).optional().default([]),
  toolHints: z.array(z.string().min(1).max(200)).optional().default([]),
  triggerExamples: z.array(z.string().min(1).max(1000)).optional().default([]),
  category: z.string().min(1).max(80).optional().default("general"),
  copiedFromSkillId: z.string().uuid().nullable().optional(),
  copiedFromCharacterId: z.string().uuid().nullable().optional(),
  sourceType: skillSourceTypeSchema.optional().default("manual"),
  sourceSessionId: z.string().optional(),
  status: skillStatusSchema.optional().default("active"),
  inferFromSession: z.boolean().optional().default(false),
});

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(10000).nullable().optional(),
  icon: z.string().max(20).nullable().optional(),
  promptTemplate: z.string().min(1).max(400000).optional(),
  inputParameters: z.array(skillInputParameterSchema).optional(),
  toolHints: z.array(z.string().min(1).max(200)).optional(),
  triggerExamples: z.array(z.string().min(1).max(1000)).optional(),
  category: z.string().min(1).max(80).optional(),
  status: skillStatusSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
  changeReason: z.string().max(300).optional(),
  skipVersionBump: z.boolean().optional(),
});

export const listSkillsQuerySchema = z.object({
  characterId: z.string().optional(),
  status: skillStatusSchema.optional(),
  all: z.coerce.boolean().optional(),
  category: z.string().min(1).max(80).optional(),
  query: z.string().min(1).max(120).optional(),
  q: z.string().min(1).max(120).optional(),
  usageBucket: z.enum(["unused", "low", "medium", "high"]).optional(),
  successBucket: z.enum(["poor", "fair", "good", "great"]).optional(),
  updatedFrom: z.string().datetime().optional(),
  updatedTo: z.string().datetime().optional(),
  sort: z.enum(["updated_desc", "updated_asc", "relevance", "success_desc", "runs_desc"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const runSkillSchema = z.object({
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
  schedule: z
    .object({
      name: z.string().min(1).max(120),
      scheduleType: z.enum(["cron", "interval", "once"]),
      cronExpression: z.string().optional(),
      intervalMinutes: z.number().int().positive().optional(),
      scheduledAt: z.string().optional(),
      timezone: z.string().optional(),
      deliveryChannel: z.enum(["app", "telegram", "slack", "whatsapp", "auto"]).optional(),
    })
    .optional(),
});

export const scheduleSkillSchema = z.object({
  name: z.string().min(1).max(120),
  scheduleType: z.enum(["cron", "interval", "once"]),
  cronExpression: z.string().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  scheduledAt: z.string().optional(),
  timezone: z.string().optional(),
  deliveryMethod: z.enum(["session", "channel", "email", "slack", "webhook"]).optional(),
  deliveryConfig: z.record(z.string(), z.unknown()).optional(),
  createNewSessionPerRun: z.boolean().optional(),
  promptVariables: z.record(z.string(), z.string()).optional(),
});
