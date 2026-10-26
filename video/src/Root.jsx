import { AbsoluteFill, Composition, useCurrentFrame } from "remotion";

// A one-second card that proves the toolchain renders; the real cut replaces it.
const Check = () => (
  <AbsoluteFill style={{ background: "#37003c", color: "#fff", justifyContent: "center", alignItems: "center", fontSize: 72, fontFamily: "sans-serif" }}>
    Studio Desk {useCurrentFrame()}
  </AbsoluteFill>
);

export const Root = () => <Composition id="check" component={Check} durationInFrames={30} fps={30} width={1920} height={1080} />;
