// The pieces of following Facebook's cursor, one at a time: reading the
// tokens and query off a search page, building the next-page request, and
// reading Facebook's answers (including its error shapes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecipe, pagingForm, nextVariables, findQueryId, readPage, jazoest, PAGING_QUERY } from '../src/facebook/paging.js';

const BASE = 'https://www.facebook.com';
const listing = (id, title = 'Trek bike') => ({ node: { __typename: 'MarketplaceFeedListingStoryObject', listing: { id, marketplace_listing_title: title, listing_price: { amount: '120.00', formatted_amount: '$120' } } } });
const answer = (edges, pageInfo) => `for (;;);${JSON.stringify({ data: { marketplace_search: { feed_units: { edges, page_info: pageInfo } } } })}`;

test('reads the tokens, the search query and the script files off a search page', () => {
  const defines = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { define: [['DTSGInitialData', [], { token: 'NAcDtsg:1' }, 258], ['LSD', [], { token: 'AVqLsd' }, 323], ['CurrentUserInitialData', [], { USER_ID: '1000123', NAME: 'Pat Example' }, 270], ['SiteData', [], { server_revision: 1017000 }, 317]] } }]]] };
  const preload = { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_CometMarketplaceSearchContentContainerQueryRelayPreloader_1', { __bbox: { complete: true } }]], ['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPreloader', 'x', [], [{ queryID: '9000000000000001', preloaderID: 'adp_CometMarketplaceSearchContentContainerQueryRelayPreloader_1', variables: { count: 24, cursor: null, params: { bqf: { query: 'bike' } } } }]]] } }]]] };
  const html = `<html><head><link rel="preload" href="https://static.xx.fbcdn.net/rsrc.php/v3/a.js" as="script"><link rel="stylesheet" href="https://static.xx.fbcdn.net/rsrc.php/v3/b.css"></head><body>
    <script type="application/json" data-sjs>${JSON.stringify(defines)}</script>
    <script type="application/json" data-sjs>${JSON.stringify(preload)}</script>
    <script src="/rsrc.php/v3/c.js?_nc_x=1&amp;y=2"></script></body></html>`;
  const r = readRecipe(html, BASE);
  assert.deepEqual(r.tokens, { dtsg: 'NAcDtsg:1', lsd: 'AVqLsd', userId: '1000123', name: 'Pat Example', rev: '1017000' });
  assert.equal(r.query.docId, '9000000000000001');
  assert.deepEqual(r.query.variables.params, { bqf: { query: 'bike' } });
  assert.deepEqual(r.scripts, ['https://static.xx.fbcdn.net/rsrc.php/v3/a.js', 'https://www.facebook.com/rsrc.php/v3/c.js?_nc_x=1&y=2'], 'scripts only, not stylesheets');
});

test('builds the same next-page request as Facebook’s page code', () => {
  assert.equal(jazoest('abc'), '2294');
  const tokens = { dtsg: 'NAcDtsg:1', lsd: 'AVqLsd', userId: '1000123', rev: '1017000' };
  const vars = nextVariables({ count: 24, cursor: null, params: { bqf: { query: 'bike' } } }, 'CURSOR2');
  assert.deepEqual(vars, { count: 24, cursor: 'CURSOR2', params: { bqf: { query: 'bike' } } });
  const f = pagingForm({ docId: '24000000000000001', variables: vars, tokens, now: 1790000000000 });
  assert.equal(f.get('doc_id'), '24000000000000001');
  assert.equal(f.get('fb_api_req_friendly_name'), PAGING_QUERY);
  assert.equal(f.get('fb_dtsg'), 'NAcDtsg:1');
  assert.equal(f.get('jazoest'), jazoest('NAcDtsg:1'));
  assert.equal(f.get('av'), '1000123');
  assert.equal(f.get('__spin_t'), '1790000000');
  assert.deepEqual(JSON.parse(f.get('variables')), vars);
});

test("finds the next-page query's id in a script file", () => {
  const js = '__d("Other_facebookRelayOperation",[],(function(a,b,c,d,e,f){e.exports="111111111"}),null);\n__d("CometMarketplaceSearchContentPaginationQuery_facebookRelayOperation",[],(function(a,b,c,d,e,f){e.exports="24000000000000001"}),null);';
  assert.equal(findQueryId(js), '24000000000000001');
  assert.equal(findQueryId('__d("Nothing",[],function(){})'), null);
});

test('reads a page of results, the next cursor, and the last page', () => {
  const mid = readPage(`${answer([listing('1010101010'), listing('1020202020')], { has_next_page: true, end_cursor: 'C3' })}\n{"label":"deferred","data":{}}`, BASE);
  assert.equal(mid.ok, true);
  assert.deepEqual(mid.listings.map((l) => l.id), ['1010101010', '1020202020']);
  assert.deepEqual([mid.hasMore, mid.cursor], [true, 'C3']);
  const last = readPage(answer([], { has_next_page: false, end_cursor: null }), BASE);
  assert.deepEqual([last.ok, last.hasMore, last.listings.length], [true, false, 0], 'an empty last page is the end, not an error');
});

test("reads Facebook's errors: signed out, unknown query, slow down, and the rest", () => {
  const signedOut = readPage('for (;;);{"__ar":1,"error":1357001,"errorSummary":"Not Logged In","errorDescription":"Please log in to continue.","payload":null}', BASE);
  assert.equal(signedOut.problem, 'login');
  const otherClassic = readPage('for (;;);{"__ar":1,"error":1357004,"errorSummary":"Sorry, something went wrong","payload":null}', BASE);
  assert.equal(otherClassic.problem, 'other', 'only "not logged in" blames the cookies');
  assert.equal(readPage('{"errors":[{"message":"PersistedQueryNotFound","code":1675030}],"data":null}', BASE).problem, 'query');
  assert.equal(readPage('{"errors":[{"message":"Variable \\"$params\\" of required type was not provided."}]}', BASE).problem, 'query');
  assert.equal(readPage('{"errors":[{"code":1675004,"message":"Rate limit exceeded"}]}', BASE).problem, 'rate');
  assert.equal(readPage('<html><body><form id="login_form" action="/login/"></form></body></html>', BASE).problem, 'login');
  assert.equal(readPage('<html><body>Something else</body></html>', BASE).problem, 'other');
});
