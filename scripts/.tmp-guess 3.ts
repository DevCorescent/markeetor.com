import { guessCompanyDomain } from '@/server/services/enrichment';
async function main() {
  for (const n of ['Aivance Llp', 'Grow Grandeur Llp', 'Vaid Consultancy Llp', 'Akshar Eye Clinic']) {
    const t = Date.now();
    console.log(n, '→', await guessCompanyDomain(n, 'IN'), `${Date.now() - t}ms`);
  }
  process.exit(0);
}
main();
