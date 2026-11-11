import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { type Dispatch, type SetStateAction, useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusBannerKey: string | null;
  setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
  onHeightChange?: (height: number) => void;
}) {
  const {
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
    onHeightChange,
  } = props;
  const laneRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the pinned banner lane before paint so the timeline header clears visible banners
  useLayoutEffect(() => {
    const element = laneRef.current;
    if (!element || !onHeightChange) return;
    const updateHeight = () => {
      onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    };
    updateHeight();
    const stopObserving = observeResize(element, updateHeight);
    return () => {
      stopObserving();
      onHeightChange(0);
    };
  }, [onHeightChange]);
  return (
    <div
      ref={laneRef}
      className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col"
    >
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
    </div>
  );
}
