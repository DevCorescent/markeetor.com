export type Align = 'left' | 'center' | 'right';

export type Block =
  | { id: string; type: 'heading'; text: string; level: 1 | 2 | 3; align: Align }
  | { id: string; type: 'text'; html: string; align: Align }
  | { id: string; type: 'button'; label: string; url: string; align: Align; variant: 'solid' | 'outline'; fullWidth: boolean }
  | { id: string; type: 'image'; src: string; alt: string; width: number; href: string; align: Align }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; height: number }
  | { id: string; type: 'columns'; left: string; right: string }
  | { id: string; type: 'quote'; html: string; author: string }
  | { id: string; type: 'footer'; html: string }
  | { id: string; type: 'html'; html: string };

export type BlockType = Block['type'];

export type EmailSettings = {
  width: number;
  background: string;
  canvas: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  font: 'Helvetica' | 'Georgia' | 'Inter' | 'Arial' | 'Trebuchet';
  radius: number;
  padding: number;
};

export type EmailDesign = { version: 1; settings: EmailSettings; blocks: Block[] };

export const VARIABLES = [
  { key: 'firstName', label: 'First name', sample: 'Jordan' },
  { key: 'lastName', label: 'Last name', sample: 'Rivera' },
  { key: 'fullName', label: 'Full name', sample: 'Jordan Rivera' },
  { key: 'company', label: 'Company', sample: 'Northwind Traders' },
  { key: 'jobTitle', label: 'Job title', sample: 'Operations Director' },
  { key: 'city', label: 'City', sample: 'Austin' },
  { key: 'country', label: 'Country', sample: 'United States' },
  { key: 'senderName', label: 'Sender name', sample: 'Alex Morgan' },
  { key: 'senderEmail', label: 'Sender email', sample: 'alex@example.com' },
  { key: 'organizationName', label: 'Organization', sample: 'Your Company' },
  { key: 'unsubscribeUrl', label: 'Unsubscribe link', sample: '#unsubscribe' },
  { key: 'currentYear', label: 'Current year', sample: String(new Date().getFullYear()) },
] as const;

/** Extra variables available only in the automated welcome email (filled per recipient when their account is created). */
export const ACCOUNT_VARIABLES = [
  { key: 'username', label: 'Username', sample: 'jordan@northwind.example' },
  { key: 'temporaryPassword', label: 'Temporary password', sample: 'Kp7#mQ2x-Rt9v' },
  { key: 'loginUrl', label: 'Sign-in link', sample: 'https://markeetor.com/login' },
  { key: 'passwordExpiresOn', label: 'Password expiry date', sample: '13 Oct 2026' },
  { key: 'workspaceName', label: 'Workspace name', sample: 'Northwind Traders' },
] as const;

export type VariableDef = { key: string; label: string; sample: string };
export type VariableKey = (typeof VARIABLES)[number]['key'] | (typeof ACCOUNT_VARIABLES)[number]['key'];
export type Variables = Partial<Record<VariableKey, string>>;

export const SAMPLE_VARIABLES: Variables = Object.fromEntries([...VARIABLES, ...ACCOUNT_VARIABLES].map((v) => [v.key, v.sample]));
