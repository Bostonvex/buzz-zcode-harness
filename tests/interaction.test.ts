/**
 * Interaction adapter unit tests — ported from Python test_interaction.
 * Pure function tests: classification, permission mapping, ExitPlanMode,
 * AskUserQuestion split (single + multi-select), response parsing.
 */

import { describe, expect, it } from "vitest";

import {
  acpPermissionResponseToExitPlanMode,
  acpPermissionResponseToZcode,
  buildAskUserAcpParams,
  exitPlanModeToAcpPermission,
  isAskUserQuestion,
  isExitPlanMode,
  isPermissionRequest,
  isUserInputRequest,
  parseAskUserResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../src/interaction/adapter.js";

describe("classification", () => {
  it("distinguishes permission vs userInput methods", () => {
    expect(isPermissionRequest("interaction/requestPermission")).toBe(true);
    expect(isPermissionRequest("interaction/requestUserInput")).toBe(false);
    expect(isUserInputRequest("interaction/requestUserInput")).toBe(true);
    expect(isUserInputRequest("interaction/requestPermission")).toBe(false);
  });

  it("detects ExitPlanMode by schema.interaction=plan_approval", () => {
    expect(isExitPlanMode({ schema: { interaction: "plan_approval" } })).toBe(true);
    expect(isExitPlanMode({ schema: { toolName: "X" } })).toBe(false);
    expect(isExitPlanMode({})).toBe(false);
  });

  it("AskUserQuestion = userInput without plan_approval", () => {
    expect(
      isAskUserQuestion("interaction/requestUserInput", {
        schema: { toolName: "AskUserQuestion" },
      }),
    ).toBe(true);
    expect(
      isAskUserQuestion("interaction/requestUserInput", {
        schema: { interaction: "plan_approval" },
      }),
    ).toBe(false);
    expect(isAskUserQuestion("interaction/requestPermission", {})).toBe(false);
  });
});

describe("zcode permission → ACP", () => {
  it("passes options through and wraps toolCall", () => {
    const params = {
      requestId: "r1",
      toolCallId: "tc_1",
      toolName: "Bash",
      input: { command: "ls" },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    };
    const acp = zcodePermissionToAcp(params, "acp_1");
    expect(acp).not.toBeNull();
    expect(acp!.options).toHaveLength(2);
    expect(acp!.options[0].optionId).toBe("allow");
    expect(acp!.toolCall.toolCallId).toBe("tc_1");
    expect(acp!.sessionId).toBe("acp_1");
  });

  it("returns null when no valid options", () => {
    expect(zcodePermissionToAcp({ toolCallId: "t", options: [] } as never, "acp_1")).toBeNull();
  });
});

describe("ACP response → zcode permission", () => {
  it("allow → decision allow", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "allow" } })
        .decision,
    ).toBe("allow");
  });
  it("reject → decision deny", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "reject" } })
        .decision,
    ).toBe("deny");
  });
  it("cancelled → decision deny", () => {
    expect(acpPermissionResponseToZcode({ outcome: { outcome: "cancelled" } }).decision).toBe(
      "deny",
    );
  });
});

describe("ExitPlanMode", () => {
  it("synthesizes approve/reject options", () => {
    const acp = exitPlanModeToAcpPermission({ toolCallId: "tc_2" } as never, "acp_1");
    expect(acp.options.map((o) => o.optionId)).toEqual(["approve", "reject"]);
  });
  it("approve → accept with content.answer_0", () => {
    const r = acpPermissionResponseToExitPlanMode({
      outcome: { outcome: "selected", optionId: "approve" },
    });
    expect(r.action).toBe("accept");
    expect((r as { content: { answer_0: string } }).content.answer_0).toBe("approve");
  });
  it("reject → decline", () => {
    expect(
      acpPermissionResponseToExitPlanMode({ outcome: { outcome: "selected", optionId: "reject" } })
        .action,
    ).toBe("decline");
  });
});

describe("AskUserQuestion split", () => {
  it("single-select: one option per label + Skip", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
    } as never);
    expect(qs).not.toBeNull();
    expect(qs).toHaveLength(1);
    expect(qs![0].multiSelect).toBe(false);
    expect(qs![0].options.map((o) => o.optionId)).toEqual(["A", "B", "__skip__"]);
  });

  it("multi-select: each option becomes a yes/no pair", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [
        { question: "Which?", multiSelect: true, options: [{ label: "auth" }, { label: "log" }] },
      ],
    } as never);
    expect(qs).toHaveLength(1);
    expect(qs![0].multiSelect).toBe(true);
    const ids = qs![0].options.map((o) => o.optionId);
    expect(ids).toEqual(["auth:yes", "auth:no", "log:yes", "log:no"]);
  });

  it("multiple questions → separate entries", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [
        { question: "Q1?", options: [{ label: "A" }] },
        { question: "Q2?", multiSelect: true, options: [{ label: "X" }] },
      ],
    } as never);
    expect(qs).toHaveLength(2);
    expect(qs![0].question).toBe("Q1?");
    expect(qs![1].question).toBe("Q2?");
  });

  it("returns null when no valid questions", () => {
    expect(splitAskUserQuestions({ toolCallId: "tc", questions: [] } as never)).toBeNull();
  });

  it("falls back to input.questions when top-level absent", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      input: { questions: [{ question: "From input?", options: [{ label: "Y" }] }] },
    } as never);
    expect(qs).toHaveLength(1);
    expect(qs![0].question).toBe("From input?");
  });
});

describe("buildAskUserAcpParams", () => {
  it("constructs the ACP params with options + toolCall", () => {
    const params = buildAskUserAcpParams(
      { toolCallId: "tc", input: { some: "in" } } as never,
      "acp_1",
      [{ optionId: "A", kind: "allow_once", name: "A" }],
    );
    expect(params.sessionId).toBe("acp_1");
    expect(params.options).toHaveLength(1);
    expect(params.toolCall.toolCallId).toBe("tc");
  });
});

describe("parseAskUserResponse", () => {
  it("single-select returns the label", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "Option A" } })).toBe(
      "Option A",
    );
  });
  it("multi-select yes → 'yes'", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "auth:yes" } })).toBe(
      "yes",
    );
  });
  it("multi-select no → 'no'", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "log:no" } })).toBe(
      "no",
    );
  });
  it("skip → null", () => {
    expect(
      parseAskUserResponse({ outcome: { outcome: "selected", optionId: "__skip__" } }),
    ).toBeNull();
  });
  it("cancelled → null", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "cancelled" } })).toBeNull();
  });
});
