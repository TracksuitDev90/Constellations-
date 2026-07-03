/**
 * First-match guided onboarding: a sequence of bottom-center toasts, each
 * dismissed by the player actually performing the action it teaches
 * (Auralux teaches by doing, not by reading). Completion persists in
 * localStorage so the hints only ever run once.
 */

export type TutorialEvent = 'select' | 'select-full' | 'command' | 'lasso' | 'feed';

const STORAGE_KEY = 'constellations.tutorialDone';

interface Step {
  text: string;
  /** Events that complete this step. */
  advanceOn: TutorialEvent[];
}

const STEPS: Step[] = [
  {
    text: 'Tap one of your stars to gather half its swarm — tap it again for the whole swarm.',
    advanceOn: ['select'],
  },
  {
    text: 'Now tap any other star to send them. Colliding ships destroy each other one-for-one.',
    advanceOn: ['command', 'feed'],
  },
  {
    text: 'Drag across empty space to lasso any of your units, wherever they are.',
    advanceOn: ['lasso'],
  },
  {
    text: 'Send units into your own ringed star to fill its rings — fill them all and it evolves into a bigger, faster star.',
    advanceOn: ['feed'],
  },
  {
    text: 'Capture every star to win. Good luck, commander.',
    advanceOn: [],
  },
];

/** Seconds the final (informational) step lingers before fading out. */
const FINAL_STEP_LINGER_MS = 6000;

export const tutorialCompleted = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true; // storage unavailable → don't nag every match
  }
};

export class Tutorial {
  private toast: HTMLDivElement;
  private stepIdx = 0;
  private finished = false;

  constructor(container: HTMLElement) {
    this.toast = document.createElement('div');
    Object.assign(this.toast.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'max(28px, env(safe-area-inset-bottom))',
      transform: 'translateX(-50%)',
      maxWidth: 'min(520px, 86vw)',
      padding: '12px 18px',
      background: 'rgba(8, 14, 28, 0.82)',
      border: '1px solid rgba(122, 212, 255, 0.35)',
      borderRadius: '10px',
      color: '#dbe6f8',
      fontSize: '14px',
      lineHeight: '1.45',
      textAlign: 'center',
      pointerEvents: 'none',
      transition: 'opacity 0.4s ease',
      opacity: '0',
      zIndex: '5',
    } as CSSStyleDeclaration);
    container.appendChild(this.toast);
    this.showStep();
  }

  /** Report a gameplay action; advances the current step if it matches. */
  notify(event: TutorialEvent): void {
    if (this.finished) return;
    const step = STEPS[this.stepIdx];
    if (!step) return;
    // A full-swarm gather also satisfies the basic select step.
    const matches =
      step.advanceOn.includes(event) ||
      (event === 'select-full' && step.advanceOn.includes('select'));
    if (!matches) return;
    this.stepIdx++;
    this.showStep();
  }

  private showStep(): void {
    const step = STEPS[this.stepIdx];
    if (!step) {
      this.complete();
      return;
    }
    this.toast.textContent = step.text;
    this.toast.style.opacity = '1';
    if (step.advanceOn.length === 0) {
      // Informational final step: linger, then finish.
      window.setTimeout(() => this.complete(), FINAL_STEP_LINGER_MS);
    }
  }

  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Private-mode storage failure is fine — hints just reappear next run.
    }
    this.toast.style.opacity = '0';
    window.setTimeout(() => this.toast.remove(), 500);
  }

  destroy(): void {
    this.finished = true;
    this.toast.remove();
  }
}
