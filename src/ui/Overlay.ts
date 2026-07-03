export interface OverlayButton {
  label: string;
  /** Optional small second line (level blurbs, lock hints). */
  sub?: string;
  /** Renders dimmed and inert — used for locked campaign levels. */
  disabled?: boolean;
  onClick: () => void;
}

export const showOverlay = (
  container: HTMLElement,
  title: string,
  body: string,
  buttons: OverlayButton[],
): HTMLDivElement => {
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(5, 8, 16, 0.72)',
    backdropFilter: 'blur(8px)',
    color: '#e2e8f5',
    textAlign: 'center',
    padding: '24px',
    gap: '12px',
    overflowY: 'auto',
  } as CSSStyleDeclaration);

  const h = document.createElement('h1');
  h.textContent = title;
  Object.assign(h.style, {
    fontSize: 'clamp(28px, 6vw, 56px)',
    fontWeight: '300',
    letterSpacing: '0.12em',
    margin: '0',
    textTransform: 'uppercase',
    textShadow: '0 0 24px rgba(122, 212, 255, 0.45)',
  });

  const p = document.createElement('p');
  p.innerHTML = body;
  Object.assign(p.style, {
    maxWidth: '520px',
    lineHeight: '1.55',
    fontSize: '15px',
    opacity: '0.85',
    margin: '0',
  });

  panel.appendChild(h);
  panel.appendChild(p);

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, {
    display: 'flex',
    gap: '10px',
    marginTop: '12px',
    flexWrap: 'wrap',
    justifyContent: 'center',
    maxWidth: '660px',
  });
  for (const b of buttons) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      padding: '12px 22px',
      fontSize: '15px',
      background: 'linear-gradient(180deg, rgba(122,212,255,0.2), rgba(122,212,255,0.08))',
      border: '1px solid rgba(122,212,255,0.45)',
      color: '#e2e8f5',
      borderRadius: '8px',
      cursor: b.disabled ? 'default' : 'pointer',
      letterSpacing: '0.04em',
      opacity: b.disabled ? '0.35' : '1',
      // Two-line buttons (label + sub) share a fixed flexible width so the
      // level-select grid reads as tidy cards.
      flex: b.sub !== undefined ? '1 1 280px' : '0 0 auto',
      maxWidth: b.sub !== undefined ? '320px' : 'none',
      touchAction: 'manipulation',
    });
    const label = document.createElement('div');
    label.textContent = b.label;
    btn.appendChild(label);
    if (b.sub) {
      const sub = document.createElement('div');
      sub.textContent = b.sub;
      Object.assign(sub.style, {
        fontSize: '12px',
        opacity: '0.65',
        marginTop: '4px',
        lineHeight: '1.35',
      });
      btn.appendChild(sub);
    }
    if (!b.disabled) btn.addEventListener('click', b.onClick);
    btnRow.appendChild(btn);
  }
  panel.appendChild(btnRow);

  container.appendChild(panel);
  return panel;
};
