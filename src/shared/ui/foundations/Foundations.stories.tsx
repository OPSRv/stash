import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties, ReactNode } from 'react';

/* Stash design-system foundations.
 *
 * One Storybook section per token cluster (Colors, Typography, Spacing,
 * Radii, Shadows, Motion). The stories render the spec values verbatim so
 * a designer can compare the live build to `colors_and_type.css` from the
 * design bundle without leaving Storybook.
 *
 * Authoring rules:
 *   - Read tokens via CSS vars only — never hard-code rgb/hex.
 *   - Surface decorator forces `surface=plain` so the swatch chrome
 *     reads against `--bg-window`, not against a translucent pane.
 *   - Light/dark flips happen automatically via the global toolbar.
 */

const meta = {
  title: 'Foundations/Tokens',
  parameters: {
    layout: 'fullscreen',
    surface: 'plain',
  },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: 24,
          minHeight: '100vh',
          background: 'var(--bg-window)',
          color: 'var(--fg)',
          fontFamily: 'var(--font-sys)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/* ────────────── shared bits ────────────── */

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2
    className="stash-section-label"
    style={{ marginBottom: 12, marginTop: 24 }}
  >
    {children}
  </h2>
);

const Grid = ({
  children,
  cols = 4,
  gap = 12,
}: {
  children: ReactNode;
  cols?: number;
  gap?: number;
}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gap,
    }}
  >
    {children}
  </div>
);

const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div
    style={{
      padding: 12,
      background: 'var(--bg-pane)',
      border: '0.5px solid var(--hairline)',
      borderRadius: 'var(--r-lg)',
      ...style,
    }}
  >
    {children}
  </div>
);

const TokenName = ({ children }: { children: ReactNode }) => (
  <code
    style={{
      font: 'var(--t-time)',
      color: 'var(--fg-mute)',
    }}
  >
    {children}
  </code>
);

const Caption = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      font: 'var(--t-ui-sm)',
      color: 'var(--fg-faint)',
      marginTop: 4,
    }}
  >
    {children}
  </div>
);

/* ────────────── colors ────────────── */

const Swatch = ({
  name,
  cssVar,
  hint,
  size = 56,
}: {
  name: string;
  cssVar: string;
  hint?: string;
  size?: number;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div
      style={{
        width: '100%',
        height: size,
        background: `var(${cssVar})`,
        border: '0.5px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
      }}
    />
    <TokenName>{cssVar}</TokenName>
    <div style={{ font: 'var(--t-ui-sm)', color: 'var(--fg)' }}>{name}</div>
    {hint && <Caption>{hint}</Caption>}
  </div>
);

export const Surfaces: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Surfaces</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Three opaque surfaces stack: <code>--bg-window</code> (popup chrome) →{' '}
        <code>--bg-sidebar</code> (slightly darker) → <code>--bg-pane</code> (main content).{' '}
        <code>--bg-elev</code> lifts buttons, modals, audio chips. Hover and active rows are
        translucent washes — never solid swaps.
      </p>
      <SectionTitle>Backgrounds</SectionTitle>
      <Grid cols={4}>
        <Swatch name="Window" cssVar="--bg-window" hint="popup outer chrome" />
        <Swatch name="Sidebar" cssVar="--bg-sidebar" hint="slightly darker than pane" />
        <Swatch name="Pane" cssVar="--bg-pane" hint="main content" />
        <Swatch name="Elev" cssVar="--bg-elev" hint="buttons, modals, audio chips" />
      </Grid>
      <SectionTitle>Translucent washes</SectionTitle>
      <Grid cols={2}>
        <Swatch name="Hover" cssVar="--bg-hover" hint="rgba(0,0,0,0.04) on dark" />
        <Swatch name="Row active" cssVar="--bg-row-active" />
      </Grid>
    </div>
  ),
};

export const Text: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Text</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Four-step foreground ramp. <code>--fg</code> for primary, then 62 / 42 / 28 % mute steps
        for labels, metadata, and dividers in copy. Use <code>.t-primary / .t-secondary /
        .t-tertiary / .t-ghost</code> utility classes in components.
      </p>
      <SectionTitle>Foreground ramp</SectionTitle>
      <Grid cols={4}>
        {(
          [
            { name: 'Primary', v: '--fg', sample: 'Aa' },
            { name: 'Mute', v: '--fg-mute', sample: 'Aa' },
            { name: 'Faint', v: '--fg-faint', sample: 'Aa' },
            { name: 'Ghost', v: '--fg-ghost', sample: 'Aa' },
          ] as const
        ).map(({ name, v, sample }) => (
          <Card key={v}>
            <div
              style={{
                font: 'var(--t-h1)',
                color: `var(${v})`,
                marginBottom: 8,
              }}
            >
              {sample}
            </div>
            <TokenName>{v}</TokenName>
            <Caption>{name}</Caption>
          </Card>
        ))}
      </Grid>
    </div>
  ),
};

export const Accent: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Accent</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        User-configurable, defaults to a calm blue. The system never bakes accent into more than
        CTAs, focus rings, active-row markers, and toggle-on icons. Use the toolbar above to flip
        between accent presets.
      </p>
      <SectionTitle>Variants</SectionTitle>
      <Grid cols={4}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              height: 56,
              background: 'rgb(var(--stash-accent-rgb))',
              borderRadius: 'var(--r-md)',
            }}
          />
          <TokenName>--stash-accent</TokenName>
          <Caption>solid — primary CTA, focus ring</Caption>
        </div>
        <Swatch name="Soft (18 %)" cssVar="--accent-soft" hint="hover on solid CTA" />
        <Swatch name="Fog (8 %)" cssVar="--accent-fog" hint="active note row, drop overlay" />
        <Swatch name="Foreground" cssVar="--accent-fg" hint="text on accent fills" />
      </Grid>
    </div>
  ),
};

export const Semantic: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Semantic</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Three reserved tones. Used sparingly: danger for destructive confirms and the recorder
        dot, success for "Saved" and toast checkmarks, warning for the in-flight save state.
      </p>
      <SectionTitle>Tones</SectionTitle>
      <Grid cols={3}>
        {(
          [
            { name: 'Danger', fg: '--color-danger-fg', bg: '--color-danger-bg' },
            { name: 'Success', fg: '--color-success-fg', bg: '--color-success-bg' },
            { name: 'Warning', fg: '--color-warning-fg', bg: '--color-warning-bg' },
          ] as const
        ).map(({ name, fg, bg }) => (
          <Card key={fg} style={{ background: `var(${bg})` }}>
            <div
              style={{
                font: 'var(--t-h2)',
                color: `var(${fg})`,
                marginBottom: 8,
              }}
            >
              {name}
            </div>
            <TokenName>{fg}</TokenName>
            <Caption style={{ color: `var(${fg})`, opacity: 0.6 } as CSSProperties}>
              {bg}
            </Caption>
          </Card>
        ))}
      </Grid>
    </div>
  ),
};

/* ────────────── typography ────────────── */

const TypeRow = ({
  token,
  label,
  sample,
}: {
  token: string;
  label: string;
  sample: string;
}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '180px 100px 1fr',
      gap: 16,
      alignItems: 'baseline',
      paddingBlock: 10,
      borderTop: '0.5px solid var(--hairline)',
    }}
  >
    <TokenName>{token}</TokenName>
    <Caption>{label}</Caption>
    <div style={{ font: `var(${token})`, color: 'var(--fg)' }}>{sample}</div>
  </div>
);

export const Typography: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Typography</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Native SF Pro / SF Mono. Display reserved for note titles + modal headings. Body is 13/1.6.
        Section labels are 10 px / 600 / 0.06 em uppercase. Type sizes are tight — this is a
        popup, not a webpage.
      </p>
      <SectionTitle>Type ramp</SectionTitle>
      <div>
        <TypeRow token="--t-h1" label="Preview h1" sample="The quick brown fox" />
        <TypeRow token="--t-display" label="Note title, modal h1" sample="The quick brown fox" />
        <TypeRow token="--t-h2" label="Preview h2" sample="The quick brown fox" />
        <TypeRow token="--t-h3" label="Modal heading" sample="The quick brown fox" />
        <TypeRow token="--t-body" label="Preview body" sample="The quick brown fox jumps over the lazy dog." />
        <TypeRow token="--t-ui" label="Sidebar, buttons" sample="The quick brown fox jumps over the lazy dog." />
        <TypeRow token="--t-ui-sm" label="Meta, tooltip" sample="The quick brown fox jumps over the lazy dog." />
        <TypeRow token="--t-mono" label="Editor body" sample="git commit -m 'wip'" />
        <TypeRow token="--t-label" label="Sidebar section labels" sample="FOLDERS · 4" />
        <TypeRow token="--t-time" label="Row timestamp" sample="2h · 3d · 5w" />
      </div>
    </div>
  ),
};

/* ────────────── spacing ────────────── */

const Spacer = ({ token, px }: { token: string; px: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBlock: 4 }}>
    <TokenName>{token}</TokenName>
    <Caption style={{ width: 50 } as CSSProperties}>{px} px</Caption>
    <div
      style={{
        width: px,
        height: 16,
        background: 'rgb(var(--stash-accent-rgb))',
        borderRadius: 2,
      }}
    />
  </div>
);

export const Spacing: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Spacing</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        4 px base, dense — closer to Finder than to Notion. Sidebar padding is 6–8 px, editor
        padding is 12–14 px, note rows are 7 px vertical.
      </p>
      <SectionTitle>Scale</SectionTitle>
      {[
        ['--sp-1', 2],
        ['--sp-2', 4],
        ['--sp-3', 6],
        ['--sp-4', 8],
        ['--sp-5', 10],
        ['--sp-6', 12],
        ['--sp-7', 14],
        ['--sp-8', 16],
        ['--sp-10', 20],
      ].map(([t, px]) => (
        <Spacer key={t} token={t as string} px={px as number} />
      ))}
    </div>
  ),
};

/* ────────────── radii ────────────── */

const RadiusBox = ({ token, label, px }: { token: string; label: string; px: number }) => (
  <Card>
    <div
      style={{
        height: 56,
        background: 'var(--bg-elev)',
        border: '0.5px solid var(--hairline-strong)',
        borderRadius: `var(${token})`,
        marginBottom: 8,
      }}
    />
    <TokenName>{token}</TokenName>
    <Caption>{label}</Caption>
    <Caption>{px} px</Caption>
  </Card>
);

export const Radii: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Radii</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Seven steps. Note rows / list items use <code>--r-sm</code>; buttons / inputs / context
        menus use <code>--r-lg</code>; floating panels (AI bar, attachments) use{' '}
        <code>--r-xl</code>; modals use <code>--r-2xl</code>; the popup window itself is{' '}
        <code>--r-window</code>.
      </p>
      <SectionTitle>Scale</SectionTitle>
      <Grid cols={4}>
        <RadiusBox token="--r-xs" label="tiny chips" px={3} />
        <RadiusBox token="--r-sm" label="note rows, list items" px={5} />
        <RadiusBox token="--r-md" label="search input, mode-switch" px={6} />
        <RadiusBox token="--r-lg" label="buttons, ctxmenu, audio chips" px={7} />
        <RadiusBox token="--r-xl" label="AI bar, attachments" px={10} />
        <RadiusBox token="--r-2xl" label="modals" px={12} />
        <RadiusBox token="--r-window" label="popup window" px={11} />
      </Grid>
    </div>
  ),
};

/* ────────────── shadows ────────────── */

const ShadowBox = ({ token, label }: { token: string; label: string }) => (
  <div
    style={{
      padding: 24,
      background: 'var(--bg-elev)',
      borderRadius: 'var(--r-xl)',
      boxShadow: `var(${token})`,
      border: '0.5px solid var(--hairline-strong)',
    }}
  >
    <TokenName>{token}</TokenName>
    <div style={{ font: 'var(--t-ui)', marginTop: 4, color: 'var(--fg)' }}>{label}</div>
  </div>
);

export const Shadows: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Shadows</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Big and soft, never harsh. Light theme softens drop alphas + flips inset highlights so
        cards stay visible on white.
      </p>
      <SectionTitle>Recipes</SectionTitle>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 32,
          padding: '24px 0',
        }}
      >
        <ShadowBox token="--sh-popup" label="The popup window itself" />
        <ShadowBox token="--sh-modal" label="Modals, recorder, confirm dialogs" />
        <ShadowBox token="--sh-floating" label="AI bar, ctxmenu, popovers" />
        <ShadowBox token="--sh-tooltip" label="Tooltips" />
      </div>
    </div>
  ),
};

/* ────────────── motion ────────────── */

const MotionRow = ({
  token,
  cubic,
  label,
}: {
  token: string;
  cubic: string;
  label: string;
}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '160px 1fr 240px',
      gap: 16,
      alignItems: 'center',
      paddingBlock: 10,
      borderTop: '0.5px solid var(--hairline)',
    }}
  >
    <TokenName>{token}</TokenName>
    <Caption>{label}</Caption>
    <code style={{ font: 'var(--t-mono)', color: 'var(--fg-faint)' }}>{cubic}</code>
  </div>
);

export const Motion: Story = {
  render: () => (
    <div>
      <h1 style={{ font: 'var(--t-h1)', margin: '0 0 4px' }}>Motion</h1>
      <p style={{ font: 'var(--t-ui)', color: 'var(--fg-mute)', margin: 0, maxWidth: 640 }}>
        Almost imperceptible. 80–140 ms ease for hover/focus, 160 ms quiet curve for modal
        pop-in. No springs, no parallax — decay-feel only. <code>prefers-reduced-motion</code>
        cancels animations entirely.
      </p>
      <SectionTitle>Tokens</SectionTitle>
      <MotionRow token="--t-fast" cubic="80ms ease" label="Hover, button press" />
      <MotionRow token="--t-base" cubic="140ms ease" label="State changes" />
      <MotionRow token="--t-slow" cubic="200ms ease" label="Toast in/out, larger transitions" />
      <MotionRow
        token="--ease-quiet"
        cubic="cubic-bezier(0.2, 1, 0.3, 1)"
        label="Modal pop-in (paired with 160 ms)"
      />
    </div>
  ),
};
