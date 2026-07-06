/**
 * Generates the hooks block for a project's .claude/settings.json so a
 * Claude Code session POSTs lifecycle events to the Bullpen daemon.
 * curl is used because hook commands run in the user's shell on all OSes;
 * on Windows, Claude Code executes hooks via cmd/PowerShell where curl.exe
 * ships with the OS (Win10+).
 */
export function hooksConfig(daemonUrl: string): Record<string, unknown> {
  const post = (eventName: string) => [
    {
      hooks: [
        {
          type: "command",
          command: `curl -s -X POST ${daemonUrl}/api/hooks/claude-code -H "Content-Type: application/json" -d @- --max-time 3`,
          timeout: 5,
        },
      ],
      ...(eventName === "PreToolUse" || eventName === "PostToolUse"
        ? { matcher: "*" }
        : {}),
    },
  ];

  return {
    hooks: {
      SessionStart: post("SessionStart"),
      SessionEnd: post("SessionEnd"),
      PreToolUse: post("PreToolUse"),
      PostToolUse: post("PostToolUse"),
      Stop: post("Stop"),
      SubagentStop: post("SubagentStop"),
      PreCompact: post("PreCompact"),
      Notification: post("Notification"),
    },
  };
}
