/**
 * Copyright (c) 2023 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { useCallback, useContext, useEffect, useState } from "react";
import { Redirect, useLocation } from "react-router";
import { useCurrentUser } from "./user-context";
import { FeatureFlagContext } from "./contexts/FeatureFlagContext";
import { BillingSetupModal } from "./components/UsageBasedBillingConfig";
import { SpinnerLoader } from "./components/Loader";
import { AttributionId } from "@gitpod/gitpod-protocol/lib/attribution";
import { getGitpodService } from "./service/service";
import Alert from "./components/Alert";
import { useLocalStorage } from "./hooks/use-local-storage";
import { Subscription } from "@gitpod/gitpod-protocol/lib/accounting-protocol";
import { TeamSubscription, TeamSubscription2 } from "@gitpod/gitpod-protocol/lib/team-subscription-protocol";
import { useConfetti } from "./contexts/ConfettiContext";
import { resetAllNotifications } from "./AppNotifications";
import { Currency, Plans } from "@gitpod/gitpod-protocol/lib/plans";
import ContextMenu, { ContextMenuEntry } from "./components/ContextMenu";
import CaretDown from "./icons/CaretDown.svg";
import { Team } from "@gitpod/gitpod-protocol";
import { OrgEntry } from "./menu/OrganizationSelector";
import { Heading2, Subheading } from "./components/typography/headings";
import { useCurrentOrg, useOrganizations } from "./data/organizations/orgs-query";
import { PaymentContext } from "./payment-context";

// DEFAULTS
const DEFAULT_USAGE_LIMIT = 1000;

/**
 * Keys of known page params
 */
const KEY_PERSONAL_SUB = "personalSubscription";
const KEY_TEAM1_SUB = "teamSubscription";
const KEY_TEAM2_SUB = "teamSubscription2";
//
const KEY_STRIPE_SETUP_INTENT = "setup_intent";
// const KEY_STRIPE_IGNORED = "setup_intent_client_secret";
const KEY_STRIPE_REDIRECT_STATUS = "redirect_status";

type SubscriptionType = typeof KEY_PERSONAL_SUB | typeof KEY_TEAM1_SUB | typeof KEY_TEAM2_SUB;
type PageParams = {
    oldSubscriptionOrTeamId: string;
    type: SubscriptionType;
    setupIntentId?: string;
};
type PageState = {
    phase: "call-to-action" | "trigger-signup" | "cleanup" | "done";
    attributionId?: string;
    setupIntentId?: string;
    old?: {
        planName: string;
        planDetails: string;
        subscriptionId: string;
    };
};

function SwitchToPAYG() {
    const { switchToPAYG } = useContext(FeatureFlagContext);
    const { currency } = useContext(PaymentContext);

    const user = useCurrentUser();
    const location = useLocation();
    const pageParams = parseSearchParams(location.search);
    const [pageState, setPageState] = useLocalStorage<PageState>(getLocalStorageKey(pageParams), {
        phase: "call-to-action",
    });

    const currentOrg = useCurrentOrg().data;
    const orgs = useOrganizations().data;
    const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
    const [selectedOrganization, setSelectedOrganization] = useState<Team | undefined>(undefined);
    const [showBillingSetupModal, setShowBillingSetupModal] = useState<boolean>(false);
    const [pendingStripeSubscription, setPendingStripeSubscription] = useState<boolean>(false);
    const { dropConfetti } = useConfetti();

    useEffect(() => {
        setSelectedOrganization(currentOrg);
    }, [currentOrg, setSelectedOrganization]);

    useEffect(() => {
        const phase = pageState.phase;
        const attributionId = pageState.attributionId;
        const setupIntentId = pageState.setupIntentId;
        if (phase !== "trigger-signup") {
            return;
        }

        // We're back from the Stripe modal: (safely) trigger the signup
        if (!attributionId) {
            console.error("Signup, but attributionId not set!");
            return;
        }
        if (!setupIntentId) {
            console.error("Signup, but setupIntentId not set!");
            setPageState((s) => ({ ...s, phase: "call-to-action" }));
            return;
        }

        console.log(`trigger-signup: ${JSON.stringify({ phase, attributionId, setupIntentId })}`);

        // do not await here, it might get called several times during rendering, but only first call has any effect.
        setPendingStripeSubscription(true);
        subscribeToStripe(
            setupIntentId,
            attributionId,
            (update) => {
                setPageState((prev) => ({ ...prev, ...update }));
                setPendingStripeSubscription(false);
            },
            (errorMessage) => {
                setErrorMessage(errorMessage);
                setPendingStripeSubscription(false);
            },
        ).catch(console.error);
    }, [pageState.attributionId, pageState.phase, pageState.setupIntentId, setPageState]);

    useEffect(() => {
        if (!pageParams?.type) {
            return;
        }
        const phase = pageState.phase;
        const attributionId = pageState.attributionId;
        const old = pageState.old;
        const type = pageParams.type;
        const oldSubscriptionOrTeamId = pageParams.oldSubscriptionOrTeamId;

        if (phase === "trigger-signup") {
            // Handled in separate effect
            return;
        }

        if (!type) {
            setErrorMessage("Error during params parsing: type not set!");
            return;
        }
        if (!oldSubscriptionOrTeamId) {
            setErrorMessage("Error during params parsing: oldSubscriptionOrTeamId not set!");
            return;
        }

        console.log(
            `context: ${JSON.stringify({
                state: { phase, attributionId, old },
                params: { type, oldSubscriptionOrTeamId },
                oldSubscriptionOrTeamId,
                type,
            })}`,
        );

        switch (phase) {
            case "call-to-action": {
                // Check: Can we progress?
                if (pageParams.setupIntentId) {
                    if (pageState.setupIntentId === pageParams.setupIntentId) {
                        // we've been here already
                        return;
                    }
                    setPageState((prev) => ({
                        ...prev,
                        setupIntentId: pageParams.setupIntentId,
                        phase: "trigger-signup",
                    }));
                    return;
                }

                // Just verify and display information
                let cancelled = false;
                (async () => {
                    // Old Subscription still active?
                    let derivedAttributionId: string | undefined = undefined;
                    let old: PageState["old"];
                    switch (type) {
                        case "personalSubscription": {
                            const oldSubscriptionId = oldSubscriptionOrTeamId;
                            const statement = await getGitpodService().server.getAccountStatement({});
                            if (!statement) {
                                console.error("No AccountStatement!");
                                break;
                            }
                            const sub = statement.subscriptions.find((s) => s.uid === oldSubscriptionId);
                            if (!sub) {
                                console.error(`No personal subscription ${oldSubscriptionId}!`);
                                break;
                            }
                            const now = new Date().toISOString();
                            if (Subscription.isCancelled(sub, now) || !Subscription.isActive(sub, now)) {
                                // We're happy!
                                if (!cancelled) {
                                    setPageState((prev) => ({ ...prev, phase: "done" }));
                                }
                                return;
                            }
                            old = {
                                subscriptionId: sub.uid,
                                planName: Plans.getById(sub.planId!)!.name,
                                planDetails: "personal",
                            };
                            derivedAttributionId = AttributionId.render({ kind: "user", userId: sub.userId });
                            break;
                        }

                        case "teamSubscription": {
                            const oldSubscriptionId = oldSubscriptionOrTeamId;
                            const tss = await getGitpodService().server.tsGet();
                            const ts = tss.find((s) => s.id === oldSubscriptionId);
                            if (!ts) {
                                console.error(`No TeamSubscription ${oldSubscriptionId}!`);
                                break;
                            }
                            const now = new Date().toISOString();
                            if (TeamSubscription.isCancelled(ts, now) || !TeamSubscription.isActive(ts, now)) {
                                // We're happy!
                                if (!cancelled) {
                                    setPageState((prev) => ({ ...prev, phase: "done" }));
                                }
                                return;
                            }
                            old = {
                                subscriptionId: ts.id,
                                planName: Plans.getById(ts.planId!)!.name,
                                planDetails: `${ts.quantity} Members`,
                            };
                            // User has to select/create new org
                            if (selectedOrganization) {
                                derivedAttributionId = AttributionId.render({
                                    kind: "team",
                                    teamId: selectedOrganization.id,
                                });
                            }
                            break;
                        }

                        case "teamSubscription2": {
                            const teamId = oldSubscriptionOrTeamId;
                            const ts2 = await getGitpodService().server.getTeamSubscription(teamId);
                            if (!ts2) {
                                console.error(`No TeamSubscription2 for team ${teamId}!`);
                                break;
                            }
                            const now = new Date().toISOString();
                            if (TeamSubscription2.isCancelled(ts2, now) || !TeamSubscription2.isActive(ts2, now)) {
                                // We're happy!
                                if (!cancelled) {
                                    setPageState((prev) => ({ ...prev, phase: "done" }));
                                }
                                return;
                            }
                            old = {
                                subscriptionId: ts2.id,
                                planName: Plans.getById(ts2.planId!)!.name,
                                planDetails: `${ts2.quantity} Members`,
                            };
                            derivedAttributionId = AttributionId.render({ kind: "team", teamId });
                            break;
                        }
                    }
                    if (!cancelled && !attributionId) {
                        setPageState((prev) => ({ ...prev, old, attributionId: derivedAttributionId }));
                    }
                })().catch(console.error);

                return () => {
                    cancelled = true;
                };
            }

            case "cleanup": {
                const oldSubscriptionId = old?.subscriptionId;
                if (!oldSubscriptionId) {
                    setErrorMessage("Error during cleanup: old.oldSubscriptionId not set!");
                    return;
                }

                switch (type) {
                    case "personalSubscription":
                        getGitpodService()
                            .server.subscriptionCancel(oldSubscriptionId)
                            .catch((error) => {
                                console.error(
                                    "Failed to cancel old subscription. We should take care of that async.",
                                    error,
                                );
                            });
                        break;

                    case "teamSubscription":
                        const attrId = AttributionId.parse(attributionId || "");
                        if (attrId?.kind === "team") {
                            // This should always be the case
                            getGitpodService()
                                .server.tsAddMembersToOrg(oldSubscriptionId, attrId.teamId)
                                .catch((error) => {
                                    console.error("Failed to move members to new org.", error);
                                });
                        }

                        getGitpodService()
                            .server.tsCancel(oldSubscriptionId)
                            .catch((error) => {
                                console.error(
                                    "Failed to cancel old subscription. We should take care of that async.",
                                    error,
                                );
                            });
                        break;

                    case "teamSubscription2": {
                        let teamId;
                        const parsed = attributionId && AttributionId.parse(attributionId);
                        if (parsed && parsed.kind === "team") {
                            teamId = parsed.teamId;
                        }
                        if (!teamId) {
                            // this should never be the case, but we need to re-parse the attribution id.
                            alert("Missing Organization ID.");
                            break;
                        }
                        getGitpodService()
                            .server.cancelTeamSubscription(teamId)
                            .catch((error) => {
                                console.error(
                                    "Failed to cancel old subscription. We should take care of that async.",
                                    error,
                                );
                            });
                        break;
                    }
                }
                setPageState((prev) => ({ ...prev, phase: "done" }));
                return;
            }

            case "done":
                if (!confettiDropped) {
                    confettiDropped = true;

                    // Hooray and confetti!
                    resetAllNotifications();
                    dropConfetti();
                }
                return;
        }
    }, [
        selectedOrganization,
        dropConfetti,
        setPageState,
        pageParams?.type,
        pageParams?.oldSubscriptionOrTeamId,
        pageParams?.setupIntentId,
        pageState.phase,
        pageState.attributionId,
        pageState.old,
        pageState.setupIntentId,
    ]);

    const onUpgradePlan = useCallback(async () => {
        if (pageState.phase !== "call-to-action" || !pageState.attributionId) {
            return;
        }

        setShowBillingSetupModal(true);
    }, [pageState.phase, pageState.attributionId]);

    if (!switchToPAYG || !user || !pageParams) {
        return (
            <Redirect
                to={{
                    pathname: "/workspaces",
                    state: { from: location },
                }}
            />
        );
    }

    if (pageState.phase === "done") {
        // /user/billing
        // /billing?org=123

        const attributionId = pageState.attributionId || "";
        const parsed = AttributionId.parse(attributionId);
        let billingLink = "/billing";
        const orgId = parsed?.kind === "team" ? parsed.teamId : undefined;
        if (orgId) {
            billingLink = `/billing?org=${orgId}`;
        } else {
            if (!user.additionalData?.isMigratedToTeamOnlyAttribution) {
                billingLink = "/user/billing";
            }
        }

        return (
            <div className="flex flex-col max-h-screen max-w-2xl mx-auto items-center w-full mt-24 text-center">
                <Heading2>You're now on pay-as-you-go! 🎊</Heading2>
                <Subheading>
                    New subscriptions are limited to 1000 credits ({Currency.getSymbol(currency)}9 / month) by default.
                    <br />
                    Change your monthly limit on the billing page if you need more.
                </Subheading>

                <div className="mt-12">
                    <a href={billingLink}>
                        <button className="secondary">Manage usage limit →</button>
                    </a>
                </div>
            </div>
        );
    }

    let titleModifier = "";
    if (pageParams?.type === "personalSubscription") {
        titleModifier = "personal plan";
    } else if (pageParams?.type === "teamSubscription") {
        titleModifier = "team plan";
    } else if (pageParams?.type === "teamSubscription2") {
        titleModifier = "organization's plan";
    }

    const planName = pageState.old?.planName || "Legacy Plan";
    const planDescription = pageState.old?.planDetails || "";
    const selectorEntries = getOrganizationSelectorEntries(orgs || [], setSelectedOrganization);
    return (
        <div className="flex flex-col max-h-screen max-w-2xl mx-auto items-center mt-24">
            <Heading2>{`Update your ${titleModifier}`}</Heading2>
            <Subheading className="w-full mt-3 text-center">
                Switch to the new pricing model to keep uninterrupted access and <br /> get{" "}
                <strong>large workspaces</strong> and <strong>custom timeouts</strong>.{" "}
                <a
                    className="gp-link"
                    target="_blank"
                    rel="noreferrer"
                    href="https://www.gitpod.io/blog/introducing-workspace-classes-and-flexible-pricing"
                >
                    Learn more →
                </a>
            </Subheading>
            <div className="mt-7 space-x-3 flex">
                {renderCard({
                    headline: "LEGACY PLAN",
                    title: planName,
                    description: <div className="mb-5">{planDescription}</div>,
                    selected: false,
                    action: (
                        <div className="flex">
                            <span className="text-red-600 dark:text-red-400">
                                Discontinued on <strong>March 31st</strong>
                            </span>
                        </div>
                    ),
                    additionalStyles: "",
                })}
                {renderCard({
                    headline: "NEW PLAN",
                    title: "$9 / month (1,000 credits)",
                    description: (
                        <>
                            Pay-as-you-go after that for <br /> $0.036 per credit.
                        </>
                    ),
                    selected: true,
                    action: (
                        <a
                            className="gp-link"
                            href="https://www.gitpod.io/pricing#cost-estimator"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Estimate costs
                        </a>
                    ),
                    additionalStyles: "",
                })}
            </div>
            <div className="w-full grid justify-items-center">
                <div className="w-96 mt-8 text-center">
                    {pageParams?.type === "teamSubscription" && (
                        <div className="w-full">
                            <p className="text-gray-500 text-center text-base">
                                Select organization or{" "}
                                <a className="gp-link" target="_blank" href="/orgs/new">
                                    create a new one
                                </a>
                            </p>
                            <div className="mt-2 flex-col w-full">
                                <div className="px-8 flex flex-col space-y-2">
                                    <ContextMenu
                                        customClasses="w-full left-0 cursor-pointer"
                                        menuEntries={selectorEntries}
                                    >
                                        <div>
                                            {selectedOrganization ? (
                                                <OrgEntry
                                                    id={selectedOrganization.id}
                                                    title={selectedOrganization.name}
                                                    subtitle=""
                                                    iconSize="small"
                                                />
                                            ) : (
                                                <input
                                                    className="w-full px-12 cursor-pointer font-semibold"
                                                    readOnly
                                                    type="text"
                                                    value={selectedOrganization}
                                                ></input>
                                            )}
                                            <img
                                                src={CaretDown}
                                                title="Select Account"
                                                className="filter-grayscale absolute top-1/2 right-3"
                                                alt="down caret icon"
                                            />
                                        </div>
                                    </ContextMenu>
                                </div>
                            </div>
                            <div className="mt-2 text-sm text-gray-500 w-full text-center">
                                Legacy Team Subscription <strong>members</strong> will be moved to the selected
                                organization, and the new plan will cover all organization usage.
                            </div>
                        </div>
                    )}
                </div>
                <div className="w-96 mt-8 text-center">
                    {pendingStripeSubscription && (
                        <div className="w-full text-center mb-2">
                            <SpinnerLoader small={true} content="Creating subscription with Stripe" />
                        </div>
                    )}
                    <button
                        className="w-full"
                        onClick={onUpgradePlan}
                        disabled={pageState.phase !== "call-to-action" || !pageState.attributionId}
                    >
                        Switch to pay-as-you-go
                    </button>
                    <div className="mt-2 text-sm text-gray-500 w-full text-center">
                        Remaining legacy subscription time will be refunded.
                    </div>
                </div>
                {errorMessage && (
                    <Alert className="w-full mt-10" closable={false} showIcon={true} type="error">
                        {errorMessage}
                    </Alert>
                )}
            </div>
            {showBillingSetupModal &&
                (pageState.attributionId ? (
                    <BillingSetupModal
                        attributionId={pageState.attributionId}
                        onClose={() => setShowBillingSetupModal(false)}
                    />
                ) : (
                    <SpinnerLoader small={true} />
                ))}
        </div>
    );
}

function getOrganizationSelectorEntries(organizations: Team[], setSelectedOrganization: (org: Team) => void) {
    const result: ContextMenuEntry[] = [];
    for (const org of organizations) {
        result.push({
            title: org.name,
            customContent: <OrgEntry id={org.id} title={org.name} subtitle="" iconSize="small" />,
            onClick: () => setSelectedOrganization(org),
        });
    }
    return result;
}

function renderCard(props: {
    headline: string;
    title: string;
    description: JSX.Element;
    action: JSX.Element;
    selected: boolean;
    additionalStyles?: string;
}) {
    return (
        <div
            className={`w-60 rounded-xl px-3 py-3 flex flex-col group transition ease-in-out ${
                props.selected ? "bg-gray-800 dark:bg-gray-100" : "bg-gray-100 dark:bg-gray-800"
            } ${props.additionalStyles || ""}`}
        >
            <div className="flex items-center">
                <p
                    className={`w-full pl-1 text-sm font-normal truncate ${
                        props.selected ? "text-gray-400 dark:text-gray-400" : "text-gray-400 dark:text-gray-500"
                    }`}
                    title={props.headline}
                >
                    {props.headline}
                </p>
                <input className="opacity-0" type="radio" checked={props.selected} readOnly={true} />
            </div>
            <div className="pl-1 grid auto-rows-auto">
                <div
                    className={`text-l font-semibold mt-1 ${
                        props.selected ? "text-gray-100 dark:text-gray-600" : "text-gray-700 dark:text-gray-300"
                    }`}
                >
                    {props.title}
                </div>
                <div
                    className={`text-sm font-normal truncate w-full ${
                        props.selected ? "text-gray-300 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"
                    }`}
                >
                    {props.description}
                </div>
                <div className="text-xl my-1 flex-row flex align-middle items-end">
                    <div
                        className={`text-sm font-normal truncate ${
                            props.selected ? "text-gray-300 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"
                        }`}
                    >
                        {props.action}
                    </div>
                </div>
            </div>
        </div>
    );
}

function getLocalStorageKey(p: PageParams | undefined) {
    if (!p) {
        return "switch-to-paygo-broken-key";
    }
    return `switch-to-paygo--old-sub-${p.oldSubscriptionOrTeamId}`;
}

function parseSearchParams(search: string): PageParams | undefined {
    const params = new URLSearchParams(search);
    const setupIntentId =
        (params.get(KEY_STRIPE_REDIRECT_STATUS) === "succeeded" ? params.get(KEY_STRIPE_SETUP_INTENT) : undefined) ||
        undefined;
    for (const key of [KEY_TEAM1_SUB, KEY_TEAM2_SUB, KEY_PERSONAL_SUB]) {
        let id = params.get(key);
        if (id) {
            return {
                type: key as any,
                oldSubscriptionOrTeamId: id,
                setupIntentId,
            };
        }
    }
}

let confettiDropped = false;

let subscribeToStripe_called = false;
async function subscribeToStripe(
    setupIntentId: string,
    attributionId: string,
    updateState: (u: Partial<PageState>) => void,
    onError: (e: string) => void,
) {
    if (subscribeToStripe_called) {
        return;
    }
    subscribeToStripe_called = true;

    // Do we already have a subscription (co-owner, me in another tab, reload, etc.)?
    let subscriptionId = await getGitpodService().server.findStripeSubscriptionId(attributionId);
    if (subscriptionId) {
        console.log(`${attributionId} already has a subscription! Moving to cleanup`);
        // We're happy!
        updateState({ phase: "cleanup" });
        return;
    }

    // Now we want to signup for sure
    try {
        await getGitpodService().server.subscribeToStripe(attributionId, setupIntentId, DEFAULT_USAGE_LIMIT);

        // We need to poll for the subscription to appear
        let subscriptionId: string | undefined;
        for (let i = 1; i <= 10; i++) {
            try {
                subscriptionId = await getGitpodService().server.findStripeSubscriptionId(attributionId);
                if (subscriptionId) {
                    break;
                }
            } catch (error) {
                console.error("Search for subscription failed.", error);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (!subscriptionId) {
            onError(`Could not find the subscription.`);
            return;
        }

        updateState({ phase: "cleanup" });
    } catch (error) {
        onError(`Could not subscribe to Stripe. ${error?.message || String(error)}`);
        return;
    }
}

export default SwitchToPAYG;
