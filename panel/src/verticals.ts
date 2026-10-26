// verticals.ts — what a vertical's tab (Energy; later others) gets from the app. A vertical
// is a view between House and the Studio, always mounted like the others, whose tab shows
// only once the view says it has something to show (onAvailable). App.tsx lists them.

import type { HouseView } from "../../src/house/view";
import type { SseFrame } from "./useSse";

export interface VerticalProps {
  subscribe: (fn: (f: SseFrame) => void) => () => void;
  connected: boolean;
  /** Its tab is the one shown. */
  visible: boolean;
  /** The House view's live data (the same GET api/house and frames the House tab shows), null until loaded. */
  house: HouseView | null;
  /** Whether its tab shows; called when that changes. */
  onAvailable: (available: boolean) => void;
  /** Open the Decisions feed filtered to an instance (a card's link). */
  onDecisions: (key: string) => void;
}
