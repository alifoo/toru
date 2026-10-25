export const plans = [
 {id:'free',name:'Free',price:0,use:'Try your first workflows.',credits:10,minutes:2,days:7},
 {id:'creator',name:'Creator',price:19,use:'Record and share regularly.',credits:50,minutes:5,days:30},
 {id:'studio',name:'Studio',price:49,use:'For a larger recording workload.',credits:150,minutes:5,days:30},
] as const;
/** One-off credit packs. PLACEHOLDER prices until the Stripe products exist; shown only behind NEXT_PUBLIC_CREDIT_PACKS_ENABLED. */
export const creditPacks = [
 {id:'pack-1',credits:1,price:0.9},
 {id:'pack-15',credits:15,price:13.5},
 {id:'pack-30',credits:30,price:27},
] as const;
export const creditPacksEnabled = process.env.NEXT_PUBLIC_CREDIT_PACKS_ENABLED === 'true';
/** The public repository: the GitHub star button, the Source link, the self-host card and the open-source answers point here. */
export const sourceUrl = process.env.NEXT_PUBLIC_SOURCE_URL?.trim() || 'https://github.com/alifoo/toru';

