import { Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Librarian } from '../wrappers/Librarian';
import { promptToncoin, sendToIndex } from '../wrappers/ui-utils';

// The Librarian keeps the jetton-wallet code as a public masterchain library.
// Every ZKGRM wallet loads its code from that library, so if the Librarian
// account is frozen or deleted for unpaid storage, all wallets stop working.
// Since global version 15 regular accounts can no longer publish libraries,
// so a lost library cannot be published again. Keep this account funded.
//
// The Librarian has empty code, so a plain transfer just adds to its balance.
// The message MUST be non-bounceable: for bounceable messages the storage
// phase runs before the value is credited, and an account with debt would be
// frozen by that very message.

// Masterchain storage prices (config param 18), nanoton per 2^16 seconds.
const MC_BIT_PRICE_PS = 1000n;
const MC_CELL_PRICE_PS = 500000n;
const YEAR = 365n * 24n * 3600n;

function cellStats(root: Cell) {
    const seen = new Set<string>();
    let bits = 0n;
    let cells = 0n;
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex');
        if (seen.has(h)) return;
        seen.add(h);
        cells += 1n;
        bits += BigInt(c.bits.length);
        c.refs.forEach(walk);
    };
    walk(root);
    return { bits, cells };
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const walletCode = await compile('JettonWallet');
    const librarian = provider.open(Librarian.createFromConfig({ code: walletCode }, await compile('Librarian')));
    const address = librarian.address;

    ui.write(`Librarian: ${address.toString({ bounceable: false })}`);

    const state = await librarian.getState();
    if (state.state.type !== 'active') {
        ui.write(`Librarian state is "${state.state.type}", not active. Do NOT send anything, the library may already be lost.`);
        return -1;
    }

    const { bits, cells } = cellStats(walletCode);
    const perYear = ((bits * MC_BIT_PRICE_PS + cells * MC_CELL_PRICE_PS) * YEAR) >> 16n;
    ui.write(`Library size: ${bits} bits, ${cells} cells`);
    ui.write(`Storage cost: ~${fromNano(perYear)} TON per year (~${fromNano(perYear / 12n)} TON per month)`);

    const balance = state.balance;
    ui.write(`Balance: ${fromNano(balance)} TON`);

    // Storage is paid on each transaction, so the debt grows from the last one.
    let debt = 0n;
    try {
        const res = await sendToIndex('transactions', { account: address.toRawString(), limit: 1, sort: 'desc' }, provider);
        const lastTxTime = BigInt(res.transactions[0].now);
        const elapsed = BigInt(Math.floor(Date.now() / 1000)) - lastTxTime;
        const due = (perYear * elapsed) / YEAR;
        debt = due > balance ? due - balance : 0n;
        ui.write(`Last transaction: ${new Date(Number(lastTxTime) * 1000).toISOString()}`);
        ui.write(`Estimated storage due: ${fromNano(due)} TON, unpaid after balance: ${fromNano(debt)} TON`);
    } catch (e: any) {
        ui.write(`Could not estimate storage debt (${e.message}). Send with a large margin.`);
    }

    const suggested = debt + perYear + toNano('0.5');
    ui.write(`Suggested top-up (debt + 1 year + margin): ${fromNano(suggested)} TON`);

    const amount = await promptToncoin('Enter TON amount to send to the Librarian:', ui);
    if (amount <= debt) {
        ui.write('Amount does not cover the storage debt. The account would be frozen and the library lost. Aborting.');
        return -1;
    }

    // Blueprint senders ignore `bounce` and always send bounceable messages,
    // which would freeze the Librarian. So we only print a transfer link to the
    // non-bounceable address; wallets take the bounce flag from the address form.
    const nonBounceable = address.toString({ bounceable: false, testOnly: provider.network() !== 'mainnet' });
    ui.write('');
    ui.write('Do NOT use the bounceable address (Ef...) or any Blueprint/TonConnect send for this.');
    ui.write(`Send exactly to: ${nonBounceable}`);
    ui.write(`Wallet link: ton://transfer/${nonBounceable}?amount=${amount}`);
    ui.write(`Tonkeeper:  https://app.tonkeeper.com/transfer/${nonBounceable}?amount=${amount}`);
    ui.write('In the wallet confirmation screen the address must start with "Uf" (non-bounceable).');
    ui.write('After sending, check the Librarian in an explorer: it must stay "active".');
}
