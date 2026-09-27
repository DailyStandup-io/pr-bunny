// quokka-labs/mobile: the React Native app. An offline-cart PR (scanning live in the demo), a push
// permission PR whose review ran out of turns, and some history.
import type { FixturePr, FixtureRepo } from "../types";
import { code, ORG } from "./people";

const L = (...lines: string[]) => lines.join("\n");
const REPO = `${ORG}/mobile`;

export const mobileRepo: FixtureRepo = {
  owner: ORG,
  name: "mobile",
  description: "The Quokka Labs shopping app for iOS and Android (React Native).",
  defaultBranch: "main",
  committers: ["sol-hartley", "marco-tilde", "yuki-brenner", "robin-vale"],
  files: {
    "README.md": code`
      # mobile

      The Quokka Labs app for iOS and Android, built with Expo.

          bun install
          bunx expo start
    `,
    "package.json": code`
      {
        "name": "@quokka/mobile",
        "private": true,
        "main": "index.ts",
        "scripts": {
          "start": "expo start",
          "test": "jest"
        },
        "dependencies": {
          "@react-native-async-storage/async-storage": "^2.1.0",
          "expo": "~52.0.11",
          "expo-notifications": "~0.29.9",
          "react": "18.3.1",
          "react-native": "0.76.3"
        }
      }
    `,
    "src/cart/storage.ts": code`
      import AsyncStorage from "@react-native-async-storage/async-storage";
      import type { Cart } from "./types";

      const KEY = "cart";

      export async function loadCart(): Promise<Cart | null> {
        const raw = await AsyncStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as Cart) : null;
      }

      export async function saveCart(cart: Cart): Promise<void> {
        await AsyncStorage.setItem(KEY, JSON.stringify(cart));
      }
    `,
    "src/cart/types.ts": code`
      export interface CartItem {
        sku: string;
        name: string;
        unitPriceCents: number;
        quantity: number;
      }

      export interface Cart {
        items: CartItem[];
        updatedAt: number;
      }
    `,
    "src/notifications/permissions.ts": code`
      import * as Notifications from "expo-notifications";

      /** Asked on first launch, from App.tsx. */
      export async function askForPushPermission(): Promise<boolean> {
        const { status } = await Notifications.requestPermissionsAsync();
        return status === "granted";
      }
    `,
    "src/screens/OrderConfirmation.tsx": code`
      import { Text, View } from "react-native";

      export function OrderConfirmation({ orderId }: { orderId: string }) {
        return (
          <View>
            <Text>Thanks! Your order {orderId} is on its way.</Text>
          </View>
        );
      }
    `,
    "App.tsx": code`
      import { useEffect } from "react";
      import { askForPushPermission } from "./src/notifications/permissions";
      import { RootNavigator } from "./src/navigation";

      export default function App() {
        useEffect(() => {
          askForPushPermission();
        }, []);
        return <RootNavigator />;
      }
    `,
  },
};

const pr88: FixturePr = {
  repo: REPO,
  number: 88,
  title: "Offline cart: persist the cart with MMKV",
  body: code`
    Carts get lost when the app is killed mid-checkout on Android. This moves cart storage from AsyncStorage to MMKV, which writes synchronously.

    - New \`storage.ts\` on MMKV
    - Existing AsyncStorage carts are migrated on first launch
  `,
  author: "sol-hartley",
  branch: "sol/mmkv-cart",
  base: "main",
  state: "OPEN",
  labels: ["android", "cart"],
  requestedBy: "sol-hartley",
  requestedMinutesAgo: 25,
  updatedMinutesAgo: 25,
  github: { checks: [["jest", "SUCCESS"], ["eas-build", "PENDING"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Store the cart in MMKV and migrate from AsyncStorage",
      edits: [
        {
          path: "src/cart/storage.ts",
          add: code`
            import AsyncStorage from "@react-native-async-storage/async-storage";
            import { MMKV } from "react-native-mmkv";
            import type { Cart } from "./types";

            const KEY = "cart";
            const store = new MMKV({ id: "cart" });

            export function loadCart(): Cart | null {
              const raw = store.getString(KEY);
              return raw ? (JSON.parse(raw) as Cart) : null;
            }

            export function saveCart(cart: Cart): void {
              store.set(KEY, JSON.stringify(cart));
            }

            /** One-off: move a cart saved by older versions into MMKV. */
            export async function migrateFromAsyncStorage(): Promise<void> {
              const raw = await AsyncStorage.getItem(KEY);
              if (raw) store.set(KEY, raw);
              await AsyncStorage.removeItem(KEY);
            }
          `,
        },
        {
          path: "package.json",
          replace: [['    "react-native": "0.76.3"', '    "react-native": "0.76.3",\n    "react-native-mmkv": "^3.1.0"']],
        },
      ],
    },
  ],
  recon: {
    headline: "Moves cart persistence from AsyncStorage to MMKV",
    summary:
      "Rewrites `src/cart/storage.ts` on MMKV so saves are synchronous, and adds a one-off `migrateFromAsyncStorage` that copies an old cart across. Adds `react-native-mmkv`.",
    intent: "Stop carts disappearing when Android kills the app mid-checkout.",
    areas: {
      "src/cart": ["Cart storage", "MMKV-backed load/save and a migration"],
      "(root)": ["Dependencies", "Adds react-native-mmkv"],
    },
    risks: [
      ["high", "Runs at launch: a bad stored value can crash startup"],
      ["medium", "Native dependency: needs a new build, not an OTA update"],
    ],
    minutes: [14, 6],
    estReasoning: "Small, but startup code and a native module.",
    focus: ["JSON.parse of stored data at launch", "Migration ordering", "Callers of the now-sync loadCart"],
  },
  review: {
    trail: [
      { read: "src/cart/storage.ts" },
      { grep: "loadCart", in: "src" },
      { say: "loadCart went from async to sync; callers that await it still work, but JSON.parse can now throw during render." },
      { grep: "migrateFromAsyncStorage" },
      { say: "Nothing calls migrateFromAsyncStorage yet." },
      { read: "package.json" },
    ],
    findings: [
      {
        severity: "high",
        lens: "Reliability",
        title: "A corrupted cart crashes the app on launch",
        at: { path: "src/cart/storage.ts", match: "return raw ? (JSON.parse(raw) as Cart) : null;" },
        why: "`loadCart` is now synchronous and called during the first render; a truncated or old-format value makes `JSON.parse` throw, which crashes startup every time until the app is reinstalled.",
        fix: "Wrap in try/catch, drop the bad value and return null.",
        comment: "If the stored value is ever corrupted, this throws during the first render and the app can't start. Could we catch, clear the key and return `null`?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "The migration is never called",
        at: { path: "src/cart/storage.ts", match: "export async function migrateFromAsyncStorage" },
        why: "Nothing in the app calls `migrateFromAsyncStorage`, so existing users lose their saved cart on upgrade.",
        fix: "Call it once at startup before the first `loadCart`.",
        comment: "I couldn't find a caller for this, so existing carts would be lost on upgrade. Should App.tsx call it before the first load?",
        confidence: "medium",
      },
    ],
    verdict: "address_before_merge",
    summary: "Good call moving to MMKV. Two things before it ships in a build: guard the parse at launch, and actually run the migration.",
    coverage: "Read storage.ts and searched for its callers.",
  },
};

const pr91: FixturePr = {
  repo: REPO,
  number: 91,
  title: "Ask for push permission after the first order, not on launch",
  body: "Opt-in is 31% when we ask on launch. Asking after a first order should do better. Moves the prompt to the order confirmation screen.",
  author: "marco-tilde",
  branch: "marco/push-after-order",
  base: "main",
  state: "OPEN",
  labels: ["growth"],
  requestedBy: "marco-tilde",
  requestedMinutesAgo: 60 * 4,
  updatedMinutesAgo: 60 * 4,
  github: { checks: [["jest", "SUCCESS"]] },
  commits: [
    {
      message: "Ask for push permission on the order confirmation screen",
      edits: [
        {
          path: "App.tsx",
          replace: [
            ['import { useEffect } from "react";\nimport { askForPushPermission } from "./src/notifications/permissions";\n', ""],
            ["  useEffect(() => {\n    askForPushPermission();\n  }, []);\n", ""],
          ],
        },
        {
          path: "src/screens/OrderConfirmation.tsx",
          replace: [
            ['import { Text, View } from "react-native";', 'import { useEffect } from "react";\nimport { Text, View } from "react-native";\nimport { askForPushPermission } from "../notifications/permissions";'],
            [
              "export function OrderConfirmation({ orderId }: { orderId: string }) {\n",
              L("export function OrderConfirmation({ orderId }: { orderId: string }) {", "  useEffect(() => {", "    askForPushPermission();", "  }, []);", "", ""),
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Moves the push permission prompt from launch to order confirmation",
    summary: "Removes the launch-time prompt from `App.tsx` and asks on `OrderConfirmation` instead.",
    intent: "Raise push opt-in by asking at a moment the value is obvious.",
    areas: {
      "(root)": ["App shell", "Launch-time prompt removed"],
      "src/screens": ["Order confirmation", "Prompt on mount"],
    },
    risks: [["medium", "Prompts on every order, not just the first"]],
    minutes: [7, 3],
    estReasoning: "Small UX change.",
    focus: ["How often the prompt appears", "Users who already denied"],
  },
  review: {
    findings: [
      {
        severity: "medium",
        lens: "UX",
        title: "Prompts after every order, not just the first",
        at: { path: "src/screens/OrderConfirmation.tsx", match: "    askForPushPermission();" },
        why: "The effect runs on every confirmation screen. iOS only shows the system prompt once, but Android 13+ will re-prompt until the user picks \"don't ask again\".",
        fix: "Check `getPermissionsAsync()` and a first-order flag first.",
        comment: "This asks after every order. Could we check the current status (and whether it's the first order) first?",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "Nice idea. Just make sure it only asks once.",
    coverage: "Read both files.",
  },
};

const pr84: FixturePr = {
  repo: REPO,
  number: 84,
  title: "Bump Expo SDK to 52.0.14",
  body: "Patch release with the Android keyboard fix (52.0.11 → 52.0.14).",
  author: "yuki-brenner",
  branch: "yuki/expo-52-0-14",
  base: "main",
  state: "MERGED",
  labels: ["dependencies"],
  updatedMinutesAgo: 60 * 24 * 11,
  commits: [{ message: "Bump expo to 52.0.14", edits: [{ path: "package.json", replace: [['"expo": "~52.0.11"', '"expo": "~52.0.14"']] }] }],
  recon: {
    headline: "Patch bump of the Expo SDK",
    summary: "Bumps `expo` within 52.0.x.",
    intent: "Pick up the Android keyboard fix.",
    areas: { "(root)": ["Dependencies", "expo patch bump"] },
    risks: [],
    minutes: [3, 2],
    estReasoning: "Patch bump.",
    focus: ["Nothing notable"],
  },
  review: { findings: [], verdict: "approve", summary: "LGTM, thanks!", coverage: "Checked the Expo changelog for 52.0.x." },
};

const pr85: FixturePr = {
  repo: REPO,
  number: 85,
  title: "Cart: dark mode colours",
  body: "Superseded by the design-system tokens work; closing.",
  author: "marco-tilde",
  branch: "marco/cart-dark-mode",
  base: "main",
  state: "CLOSED",
  updatedMinutesAgo: 60 * 24 * 16,
  commits: [
    {
      message: "Dark mode colours for the cart",
      edits: [{ path: "src/screens/OrderConfirmation.tsx", replace: [["    <View>", '    <View style={{ backgroundColor: "#111" }}>']] }],
    },
  ],
  recon: {
    headline: "Dark background on the order confirmation screen",
    summary: "Hard-codes a dark background colour.",
    intent: "Dark mode for the cart flow.",
    areas: { "src/screens": ["Order confirmation", "Hard-coded background"] },
    risks: [],
    minutes: [2, 1],
    estReasoning: "One line.",
    focus: ["Hard-coded colour"],
  },
  review: {
    findings: [
      {
        severity: "low",
        lens: "Maintainability",
        title: "Hard-coded colour instead of a theme token",
        at: { path: "src/screens/OrderConfirmation.tsx", match: 'backgroundColor: "#111"' },
        why: "Breaks light mode and bypasses the theme.",
        fix: "Use the theme's background token.",
        comment: "Could this use the theme token instead of `#111`?",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "One note about tokens.",
    coverage: "One line.",
  },
};

export const mobilePrs: FixturePr[] = [pr84, pr85, pr88, pr91];
