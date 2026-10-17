import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";

import { isExcalidrawPlusSignedUser } from "../app_constants";
import { useAtomValue } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import {
  cloudSaveStateAtom,
  cloudPendingUploadsAtom,
  cloudFileErrorAtom,
} from "../data/cloudStatus";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
    const collaborating = useAtomValue(isCollaboratingAtom);
    const saveState = useAtomValue(cloudSaveStateAtom);
    const pendingFiles = useAtomValue(cloudPendingUploadsAtom);
    const fileError = useAtomValue(cloudFileErrorAtom);
    const { langCode } = useI18n();
    const chinese = langCode.startsWith("zh");
    const failed = saveState === "error" || fileError;
    const saving = saveState === "saving" || pendingFiles > 0;
    const label = !collaborating
      ? chinese
        ? "仅保存在此浏览器"
        : "Saved in this browser"
      : failed
      ? chinese
        ? "云端保存失败，请保留页面"
        : "Cloud save failed; keep this page open"
      : saving || saveState === "idle"
      ? chinese
        ? "正在保存到云端…"
        : "Saving to cloud…"
      : chinese
      ? "已保存到云端"
      : "Saved to cloud";
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
          <span
            role="status"
            data-testid="cloud-save-status"
            style={{
              fontSize: "0.75rem",
              color:
                failed && collaborating ? "#c92a2a" : "var(--color-gray-60)",
            }}
            title={
              chinese
                ? "开启实时协作后，画板和图片会加密保存。请收藏完整协作链接；持有链接的人可以编辑。"
                : "Start live collaboration to save this drawing and its images to the cloud. Keep the complete room link; anyone with it can edit."
            }
          >
            {label}
          </span>
        </div>
      </Footer>
    );
  },
);
