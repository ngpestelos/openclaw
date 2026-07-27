/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeClawHubSkillIconUrl, renderSkills } from "./view.ts";

type SkillsProps = Parameters<typeof renderSkills>[0];

const dialogRestores: Array<() => void> = [];
const containers: HTMLElement[] = [];
const noop = () => undefined;

function createClawHubProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  return {
    canUpdate: true,
    canInstall: true,
    connected: true,
    loading: false,
    report: {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    },
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    },
    selectedAgentId: "main",
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    operation: null,
    messages: {},
    detailKey: null,
    detailTab: "overview",
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
    clawhubQuery: "",
    clawhubResults: null,
    clawhubIconUrls: {},
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    onAgentChange: noop,
    onFilterChange: noop,
    onStatusFilterChange: noop,
    onRefresh: noop,
    onToggle: noop,
    onEdit: noop,
    onSaveKey: noop,
    onInstall: noop,
    onDetailOpen: noop,
    onDetailClose: noop,
    onDetailTabChange: noop,
    onClawHubQueryChange: noop,
    onClawHubDetailOpen: noop,
    onClawHubDetailClose: noop,
    onClawHubInstall: noop,
    ...overrides,
  };
}

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

function installDialogMethod(value: (this: HTMLDialogElement) => void) {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(proto, "showModal");
  Object.defineProperty(proto, "showModal", { configurable: true, writable: true, value });
  dialogRestores.push(() => {
    if (original) {
      Object.defineProperty(proto, "showModal", original);
      return;
    }
    Reflect.deleteProperty(proto, "showModal");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dialogRestores.length > 0) {
    dialogRestores.pop()?.();
  }
  while (containers.length > 0) {
    containers.pop()?.remove();
  }
});

describe("normalizeClawHubSkillIconUrl", () => {
  it.each([
    {
      label: "the default registry root",
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
    },
    {
      label: "a configured registry root",
      iconUrl: `https://registry.example.test/api/v1/skill-icons/${"a".repeat(64)}`,
    },
    {
      label: "a path-mounted registry",
      iconUrl: `https://registry.example.test/clawhub/api/v1/skill-icons/${"a".repeat(64)}`,
    },
    {
      label: "a nested path-mounted registry",
      iconUrl: `https://registry.example.test/tenant/clawhub/api/v1/skill-icons/${"a".repeat(64)}`,
    },
  ])("accepts canonical skill artwork from $label", ({ iconUrl }) => {
    expect(normalizeClawHubSkillIconUrl(iconUrl)).toBe(iconUrl);
  });

  it.each([
    `http://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
    `https://clawhub.ai/api/v1/skill-icons/${"A".repeat(64)}`,
    `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}?download=1`,
    `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}#image`,
    `https://user@clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
    `https://clawhub.ai/clawhub//api/v1/skill-icons/${"a".repeat(64)}`,
    `https://clawhub.ai/clawhub%2Fprivate/api/v1/skill-icons/${"a".repeat(64)}`,
    `https://clawhub.ai/clawhub/api/v1/skill-icons/${"a".repeat(64)}/extra`,
    "https://clawhub.ai/profile.png",
    "/api/v1/skill-icons/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "not a url",
  ])("rejects noncanonical ClawHub icon source %s", (iconUrl) => {
    expect(normalizeClawHubSkillIconUrl(iconUrl)).toBeNull();
  });

  it("never renders unproxied ClawHub skill or owner images", async () => {
    const container = createContainer();
    installDialogMethod(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    const icon = `https://clawhub.ai/api/v1/skill-icons/${"c".repeat(64)}`;
    render(
      renderSkills(
        createClawHubProps({
          clawhubResults: [{ score: 1, slug: "github", displayName: "GitHub", icon }],
          clawhubDetailSlug: "github",
          clawhubDetail: {
            skill: {
              slug: "github",
              displayName: "GitHub",
              icon,
              createdAt: 1,
              updatedAt: 1,
            },
            owner: { image: "https://attacker.example/profile.png" },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".clawhub-skill-icon")).toBeNull();
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
    expect(container.querySelector(".clawhub-skill-icon--profile")).toBeNull();
  });

  it("renders ClawHub acknowledgement retry actions", () => {
    const container = createContainer();
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createClawHubProps({
          clawhubInstallMessage: {
            kind: "error",
            text: "REVIEW REQUIRED - ClawHub found suspicious behavior.",
            acknowledgeSlug: "github",
            acknowledgeVersion: "1.2.3",
          },
          onClawHubInstall,
        }),
      ),
      container,
    );

    const retryButton = container.querySelector<HTMLButtonElement>(".callout button");
    expect(container.querySelector(".callout")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "REVIEW REQUIRED - ClawHub found suspicious behavior. Acknowledge risk and install",
    );
    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    retryButton!.click();

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github", true, "1.2.3");
  });
});
