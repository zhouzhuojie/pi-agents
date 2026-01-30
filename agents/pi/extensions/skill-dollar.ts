import type { ExtensionAPI, LoadSkillsResult } from "@mariozechner/pi-coding-agent";
import { CustomEditor, getSelectListTheme, loadSkills, SettingsManager } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type SkillInfo = Pick<LoadSkillsResult["skills"][number], "name" | "description" | "filePath">;


interface DollarContext {
  prefix: string;
}

const WIDGET_ID = "skill-dollar-suggest";
const MAX_SUGGESTIONS = 8;

const normalizeToSingleLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

function buildSkillIndex(cwd: string): SkillInfo[] {
  const settings = SettingsManager.create(cwd);
  const result: LoadSkillsResult = loadSkills({ cwd, skillPaths: settings.getSkillPaths() });
  return result.skills.slice();
}

function findDollarContext(text: string, cursor: { line: number; col: number }): DollarContext | null {
  const lines = text.split("\n");
  const lineText = lines[cursor.line] ?? "";
  const prefix = lineText.slice(0, cursor.col);
  const match = prefix.match(/\$([a-z0-9-]{0,63})$/);
  if (!match) return null;

  return { prefix: match[1] };
}

function renderSkillSuggestions(
  width: number,
  matches: SkillInfo[],
  selectedIndex: number,
  theme: ReturnType<typeof getSelectListTheme>
): string[] {
  const lines: string[] = [];
  if (matches.length === 0) return lines;

  const renderValue = (rawValue: string, maxWidth: number, isSelected: boolean) => {
    const truncatedRaw = truncateToWidth(rawValue, maxWidth, "");
    const hasDollar = truncatedRaw.startsWith("$");
    const dollarPart = hasDollar ? "$" : "";
    const namePart = hasDollar ? truncatedRaw.slice(1) : truncatedRaw;
    const text = isSelected
      ? `${theme.description(dollarPart)}${theme.selectedText(namePart)}`
      : `${theme.description(dollarPart)}${namePart}`;
    return { text, width: visibleWidth(truncatedRaw) };
  };

  const maxVisible = Math.min(matches.length, MAX_SUGGESTIONS);
  const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), matches.length - maxVisible));
  const endIndex = Math.min(startIndex + maxVisible, matches.length);

  for (let i = startIndex; i < endIndex; i++) {
    const skill = matches[i];
    if (!skill) continue;

    const isSelected = i === selectedIndex;
    const prefix = isSelected ? theme.selectedPrefix("→ ") : "  ";
    const prefixWidth = visibleWidth(prefix);
    const descriptionSingleLine = skill.description ? normalizeToSingleLine(skill.description) : undefined;
    const rawValue = `$${skill.name}`;
    const maxValueWidth = Math.min(30, width - prefixWidth - 4);
    const value = renderValue(rawValue, maxValueWidth, isSelected);

    if (descriptionSingleLine && width > 40) {
      const spacing = " ".repeat(Math.max(1, 32 - value.width));
      const descriptionStart = prefixWidth + value.width + spacing.length;
      const remainingWidth = width - descriptionStart - 2;
      if (remainingWidth > 10) {
        const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
        lines.push(prefix + value.text + theme.description(spacing + truncatedDesc));
        continue;
      }
    }

    const fallback = renderValue(rawValue, width - prefixWidth - 2, isSelected);
    lines.push(prefix + fallback.text);
  }

  const scrollText = `  (${selectedIndex + 1}/${matches.length})`;
  lines.push(theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));

  return lines;
}

class SkillSuggestEditor extends CustomEditor {
  private getSkills: () => SkillInfo[];
  private setWidget: (data: { matches: SkillInfo[]; selectedIndex: number } | undefined) => void;
  private suggestionPrefix: string | null = null;
  private suggestionMatches: SkillInfo[] = [];
  private selectedIndex = 0;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    getSkills: () => SkillInfo[],
    setWidget: (data: { matches: SkillInfo[]; selectedIndex: number } | undefined) => void
  ) {
    super(tui, theme, keybindings);
    this.getSkills = getSkills;
    this.setWidget = setWidget;
  }

  handleInput(data: string): void {
    if (this.suggestionPrefix !== null && this.suggestionMatches.length > 0) {
      if (matchesKey(data, Key.up)) {
        this.selectedIndex =
          this.selectedIndex === 0 ? Math.max(0, this.suggestionMatches.length - 1) : this.selectedIndex - 1;
        this.updateWidget();
        return;
      }

      if (matchesKey(data, Key.down)) {
        this.selectedIndex =
          this.selectedIndex === this.suggestionMatches.length - 1 ? 0 : this.selectedIndex + 1;
        this.updateWidget();
        return;
      }

      if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
        this.applySelection();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        this.clearSuggestions();
        return;
      }
    }

    super.handleInput(data);
    this.updateSuggestions();
  }

  private applySelection(): void {
    const selection = this.suggestionMatches[this.selectedIndex];
    if (this.suggestionPrefix === null || !selection) {
      this.clearSuggestions();
      return;
    }

    const prefixLength = this.suggestionPrefix.length;
    for (let i = 0; i < prefixLength; i++) {
      super.handleInput("\x7f");
    }

    this.insertTextAtCursor(selection.name);

    this.clearSuggestions();
  }

  private updateSuggestions(): void {
    const skills = this.getSkills();
    if (skills.length === 0) {
      this.clearSuggestions();
      return;
    }

    const context = findDollarContext(this.getText(), this.getCursor());
    if (!context) {
      this.clearSuggestions();
      return;
    }

    const prefix = context.prefix;
    const matches = prefix ? fuzzyFilter(skills, prefix, (skill) => skill.name) : skills;

    if (matches.length === 0) {
      this.clearSuggestions();
      return;
    }

    const prefixChanged = prefix !== this.suggestionPrefix;
    this.suggestionPrefix = prefix;
    this.suggestionMatches = matches;
    this.selectedIndex = prefixChanged ? 0 : Math.min(this.selectedIndex, this.suggestionMatches.length - 1);
    this.updateWidget();
  }

  private updateWidget(): void {
    if (this.suggestionPrefix === null || this.suggestionMatches.length === 0) {
      this.setWidget(undefined);
      return;
    }

    this.setWidget({ matches: this.suggestionMatches, selectedIndex: this.selectedIndex });
  }

  private clearSuggestions(): void {
    this.suggestionPrefix = null;
    this.suggestionMatches = [];
    this.selectedIndex = 0;
    this.setWidget(undefined);
  }
}

function extractSkillMentions(text: string, skills: SkillInfo[]): SkillInfo[] {
  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
  const matches = new Set<string>();
  const regex = /\$([a-z0-9][a-z0-9-]{0,63})/g;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match) {
    const name = match[1].toLowerCase();
    if (byName.has(name)) matches.add(name);
    match = regex.exec(text);
  }

  return [...matches].map((name) => byName.get(name)!).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let skills: SkillInfo[] = [];

  const refreshSkills = async (cwd: string) => {
    skills = buildSkillIndex(cwd);
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshSkills(ctx.cwd);

    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const setWidget = (data: { matches: SkillInfo[]; selectedIndex: number } | undefined) => {
        if (!data || data.matches.length === 0) {
          ctx.ui.setWidget(WIDGET_ID, undefined);
          return;
        }

        ctx.ui.setWidget(
          WIDGET_ID,
          () => {
            const selectListTheme = getSelectListTheme();
            return {
              render: (width: number) => renderSkillSuggestions(width, data.matches, data.selectedIndex, selectListTheme),
              invalidate: () => undefined,
            };
          },
          { placement: "belowEditor" }
        );
      };

      return new SkillSuggestEditor(tui, theme, keybindings, () => skills, setWidget);
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (skills.length === 0) {
      await refreshSkills(ctx.cwd);
    }

    const mentioned = extractSkillMentions(event.prompt, skills);
    if (mentioned.length === 0) return undefined;
    return {
      message: {
        customType: "skill-dollar",
        content: "Use a skill when the user names it (with `$skill-name` or plain text) or the request matches its description, and say if it is missing or unreadable.",
        display: true,
      },
    };
  });
}
