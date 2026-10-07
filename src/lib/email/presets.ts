import { DEFAULT_SETTINGS } from './render';
import type { Block, EmailDesign } from './types';

let n = 0;
const id = () => `b${Date.now().toString(36)}${(n++).toString(36)}`;
const footer = (): Block => ({ id: id(), type: 'footer', html: '<p>{{organizationName}} · Sent to you as a business contact.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' });

export function newBlock(type: Block['type']): Block {
  switch (type) {
    case 'heading': return { id: id(), type, text: 'A clear, confident headline', level: 2, align: 'left' };
    case 'text': return { id: id(), type, html: '<p>Write your message here. Use <strong>variables</strong> like {{firstName}} to personalise it.</p>', align: 'left' };
    case 'button': return { id: id(), type, label: 'Book a call', url: 'https://', align: 'left', variant: 'solid', fullWidth: false };
    case 'image': return { id: id(), type, src: 'https://placehold.co/1040x520/0a0a0a/ffffff/png?text=Your+image', alt: 'Image', width: 100, href: '', align: 'center' };
    case 'divider': return { id: id(), type };
    case 'spacer': return { id: id(), type, height: 24 };
    case 'columns': return { id: id(), type, left: '<p><strong>Left column</strong><br/>Supporting detail.</p>', right: '<p><strong>Right column</strong><br/>Supporting detail.</p>' };
    case 'quote': return { id: id(), type, html: '<p>The difference was immediate — our team closed more, faster.</p>', author: 'A happy customer' };
    case 'footer': return footer();
    case 'html': return { id: id(), type, html: '<p>Custom HTML</p>' };
  }
}

export const PRESETS: { key: string; name: string; description: string; subject: string; preheader: string; design: () => EmailDesign }[] = [
  {
    key: 'intro', name: 'Personal introduction', description: 'Warm first touch with a single call to action', subject: 'Quick question, {{firstName}}', preheader: 'A short note from {{senderName}}',
    design: () => ({ version: 1, settings: { ...DEFAULT_SETTINGS }, blocks: [
      { id: id(), type: 'heading', text: 'Hi {{firstName}},', level: 2, align: 'left' },
      { id: id(), type: 'text', align: 'left', html: '<p>I noticed {{company}} has been growing quickly and thought it was worth reaching out. We help teams like yours turn more conversations into customers — without adding headcount.</p><p>Would a 15-minute call next week be useful?</p>' },
      { id: id(), type: 'button', label: 'Pick a time', url: 'https://', align: 'left', variant: 'solid', fullWidth: false },
      { id: id(), type: 'text', align: 'left', html: '<p>Best,<br/><strong>{{senderName}}</strong><br/>{{organizationName}}</p>' },
      footer(),
    ] }),
  },
  {
    key: 'announcement', name: 'Announcement', description: 'Hero image, headline, highlights and CTA', subject: 'Introducing something new for {{company}}', preheader: 'See what’s changed this month',
    design: () => ({ version: 1, settings: { ...DEFAULT_SETTINGS, padding: 36 }, blocks: [
      { id: id(), type: 'image', src: 'https://placehold.co/1040x480/0a0a0a/ffffff/png?text=Announcement', alt: 'Announcement', width: 100, href: '', align: 'center' },
      { id: id(), type: 'spacer', height: 12 },
      { id: id(), type: 'heading', text: 'Built for teams that move fast', level: 1, align: 'left' },
      { id: id(), type: 'text', align: 'left', html: '<p>Hi {{firstName}}, here’s what’s new and why it matters for {{company}}.</p>' },
      { id: id(), type: 'columns', left: '<p><strong>Faster setup</strong><br/>Live in a day, not a quarter.</p>', right: '<p><strong>Clear reporting</strong><br/>Every metric in one place.</p>' },
      { id: id(), type: 'button', label: 'See what’s new', url: 'https://', align: 'center', variant: 'solid', fullWidth: true },
      footer(),
    ] }),
  },
  {
    key: 'followup', name: 'Follow-up', description: 'Short, plain follow-up that feels personal', subject: 'Following up', preheader: 'Just bringing this back to the top of your inbox',
    design: () => ({ version: 1, settings: { ...DEFAULT_SETTINGS, background: '#ffffff', padding: 24 }, blocks: [
      { id: id(), type: 'text', align: 'left', html: '<p>Hi {{firstName}},</p><p>Just following up on my last note — is improving lead response times a priority for {{company}} this quarter?</p><p>If now isn’t the right time, no problem at all.</p><p>{{senderName}}</p>' },
      footer(),
    ] }),
  },
  {
    key: 'testimonial', name: 'Social proof', description: 'Quote-led email with a strong CTA', subject: 'How teams like {{company}} close faster', preheader: 'A short story worth 60 seconds',
    design: () => ({ version: 1, settings: { ...DEFAULT_SETTINGS, background: '#0a0a0a', canvas: '#ffffff' }, blocks: [
      { id: id(), type: 'heading', text: 'Results, not promises', level: 1, align: 'center' },
      { id: id(), type: 'quote', html: '<p>Within a month our response time dropped from two days to two hours. The team finally has one place to work.</p>', author: 'Head of Sales, SaaS company' },
      { id: id(), type: 'divider' },
      { id: id(), type: 'text', align: 'center', html: '<p>{{firstName}}, want to see how it would work at {{company}}?</p>' },
      { id: id(), type: 'button', label: 'Get a walkthrough', url: 'https://', align: 'center', variant: 'solid', fullWidth: false },
      footer(),
    ] }),
  },
  { key: 'blank', name: 'Blank', description: 'Start from an empty canvas', subject: '', preheader: '', design: () => ({ version: 1, settings: { ...DEFAULT_SETTINGS }, blocks: [newBlock('text'), footer()] }) },
];
