<?php
/**
 * Printed-parts inventory: parts on hand per colour, recipes (store item = parts x qty), and the
 * store quantity of every managed item = the number of full sets the parts on hand allow.
 *
 * - Parts on hand are the only real inventory. Store quantities are derived from them.
 * - A sale takes the item's parts off on hand; a cancelled / refunded order puts them back.
 * - Shared parts appear in several items at once (each item is counted on its own).
 * - Log-only mode (ONICPRINT_LIVE = 0): store quantities are computed and logged, not written.
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

class OnicPrintInventory
{
    public const CONF_LIVE = 'ONICPRINT_LIVE';

    public static function t(string $name): string
    {
        return _DB_PREFIX_ . 'onicprint_' . $name;
    }

    private static function db(): Db
    {
        return Db::getInstance();
    }

    public static function live(): bool
    {
        return (bool) Configuration::get(self::CONF_LIVE);
    }

    // ------------------------------------------------------------------ catalogue

    private static function shopId(): int
    {
        $ctx = Context::getContext();

        return (int) ($ctx->shop->id ?? 0) ?: (int) Configuration::get('PS_SHOP_DEFAULT');
    }

    /** Every sellable item: each combination, and each product without combinations (id 0). */
    public static function catalogue(): array
    {
        $p = _DB_PREFIX_;
        $lang = (int) Configuration::get('PS_LANG_DEFAULT');
        $shop = self::shopId();
        $rows = self::db()->executeS("
            SELECT pa.id_product, pa.id_product_attribute, pa.reference, pl.name AS product_name, p.active
            FROM {$p}product_attribute pa
            JOIN {$p}product p ON p.id_product = pa.id_product
            JOIN {$p}product_lang pl ON pl.id_product = pa.id_product AND pl.id_lang = $lang AND pl.id_shop = $shop
            UNION ALL
            SELECT p.id_product, 0, p.reference, pl.name, p.active
            FROM {$p}product p
            JOIN {$p}product_lang pl ON pl.id_product = p.id_product AND pl.id_lang = $lang AND pl.id_shop = $shop
            WHERE NOT EXISTS (SELECT 1 FROM {$p}product_attribute x WHERE x.id_product = p.id_product)
            ORDER BY id_product, id_product_attribute") ?: [];
        $opts = [];
        $optRows = self::db()->executeS("
            SELECT pac.id_product_attribute, agl.name AS grp, al.name AS val, ag.is_color_group
            FROM {$p}product_attribute_combination pac
            JOIN {$p}attribute a ON a.id_attribute = pac.id_attribute
            JOIN {$p}attribute_lang al ON al.id_attribute = a.id_attribute AND al.id_lang = $lang
            JOIN {$p}attribute_group ag ON ag.id_attribute_group = a.id_attribute_group
            JOIN {$p}attribute_group_lang agl ON agl.id_attribute_group = ag.id_attribute_group AND agl.id_lang = $lang
            ORDER BY ag.position, a.position") ?: [];
        foreach ($optRows as $o) {
            $opts[(int) $o['id_product_attribute']][] = [
                'group' => $o['grp'], 'value' => $o['val'],
                'colour' => (int) $o['is_color_group'] === 1 || preg_match('/colou?r/i', $o['grp']),
            ];
        }
        foreach ($rows as &$r) {
            $r['options'] = $opts[(int) $r['id_product_attribute']] ?? [];
        }

        return $rows;
    }

    /** Colour names used by the store's colour options (for per-colour stock). */
    public static function storeColours(): array
    {
        $names = [];
        foreach (self::catalogue() as $r) {
            foreach ($r['options'] as $o) {
                if ($o['colour']) {
                    $names[$o['value']] = true;
                }
            }
        }
        foreach (self::db()->executeS('SELECT DISTINCT colour FROM ' . self::t('stock') . " WHERE colour <> ''") ?: [] as $s) {
            $names[$s['colour']] = true;
        }
        $names = array_keys($names);
        sort($names, SORT_NATURAL | SORT_FLAG_CASE);

        return $names;
    }

    // ------------------------------------------------------------------ data

    public static function parts(): array
    {
        $out = [];
        foreach (self::db()->executeS('SELECT * FROM ' . self::t('part') . ' ORDER BY name') ?: [] as $r) {
            $out[] = ['id' => (int) $r['id_part'], 'name' => $r['name'], 'material' => $r['material'], 'notes' => (string) $r['notes']];
        }

        return $out;
    }

    /** "part|colour" => qty ('' = no colour). */
    public static function stockMap(): array
    {
        $m = [];
        foreach (self::db()->executeS('SELECT * FROM ' . self::t('stock')) ?: [] as $r) {
            $m[(int) $r['id_part'] . '|' . $r['colour']] = (int) $r['qty'];
        }

        return $m;
    }

    public static function stockList(): array
    {
        $out = [];
        foreach (self::stockMap() as $k => $q) {
            [$part, $colour] = explode('|', $k, 2);
            $out[] = ['partId' => (int) $part, 'colour' => $colour, 'qty' => $q];
        }

        return $out;
    }

    /** All catalogue items with their settings, recipe, print colour, store quantity and buildable sets. */
    public static function items(?array $stock = null): array
    {
        $stock = $stock ?? self::stockMap();
        $settings = [];
        foreach (self::db()->executeS('SELECT * FROM ' . self::t('item')) ?: [] as $s) {
            $settings[$s['id_product'] . '-' . $s['id_product_attribute']] = $s;
        }
        $ignore = [];
        foreach (self::db()->executeS('SELECT id_product FROM ' . self::t('product') . ' WHERE ignore_store_colour = 1') ?: [] as $s) {
            $ignore[(int) $s['id_product']] = true;
        }
        $recipes = [];
        foreach (self::db()->executeS('SELECT * FROM ' . self::t('recipe') . ' ORDER BY id_part') ?: [] as $r) {
            $recipes[$r['id_product'] . '-' . $r['id_product_attribute']][] = ['partId' => (int) $r['id_part'], 'qty' => (int) $r['qty']];
        }
        $out = [];
        foreach (self::catalogue() as $r) {
            $pid = (int) $r['id_product'];
            $cid = (int) $r['id_product_attribute'];
            $key = "$pid-$cid";
            $s = $settings[$key] ?? null;
            $storeColour = null;
            foreach ($r['options'] as $o) {
                if ($o['colour']) {
                    $storeColour = $o['value'];
                    break;
                }
            }
            $printColour = $s ? (string) $s['print_colour'] : '';
            $colour = (!isset($ignore[$pid]) && $storeColour !== null) ? $storeColour : ($printColour !== '' ? $printColour : null);
            $recipe = $recipes[$key] ?? [];
            $values = array_map(fn ($o) => $o['value'], $r['options']);
            $item = [
                'productId' => $pid, 'combinationId' => $cid, 'reference' => (string) $r['reference'],
                'productName' => $r['product_name'], 'active' => (bool) $r['active'], 'options' => $r['options'],
                'label' => $r['reference'] ?: trim($r['product_name'] . ($values ? ' - ' . implode(', ', $values) : '')),
                'storeColour' => $storeColour, 'hasStoreColour' => $storeColour !== null, 'ignoreStoreColour' => isset($ignore[$pid]),
                'printColour' => $printColour, 'colour' => $colour,
                'managed' => $s ? (bool) $s['managed'] : false, 'minQty' => $s ? (int) $s['min_qty'] : 0,
                'priority' => $s ? (int) $s['priority'] : 0, 'recipe' => $recipe,
                'storeQty' => (int) StockAvailable::getQuantityAvailableByProduct($pid, $cid),
            ];
            $item['buildable'] = self::buildable($item, $stock);
            $out[] = $item;
        }

        return $out;
    }

    /** Units of a part available for a colour (null = any colour: every colour counts). */
    public static function available(array $stock, int $partId, ?string $colour): int
    {
        if ($colour !== null) {
            return max(0, $stock["$partId|$colour"] ?? 0);
        }
        $n = 0;
        foreach ($stock as $k => $q) {
            if (strpos($k, "$partId|") === 0) {
                $n += max(0, $q);
            }
        }

        return $n;
    }

    /** Full sets the parts on hand allow (null when the item has no recipe). */
    public static function buildable(array $item, array $stock): ?int
    {
        if (!$item['recipe']) {
            return null;
        }
        $sets = PHP_INT_MAX;
        foreach ($item['recipe'] as $line) {
            $sets = min($sets, intdiv(self::available($stock, $line['partId'], $item['colour']), max(1, $line['qty'])));
        }

        return $sets;
    }

    // ------------------------------------------------------------------ stock moves

    /** Change a part's stock and record why. */
    public static function adjust(int $partId, string $colour, int $delta, string $reason, ?int $idOrder = null, string $ref = '', string $note = ''): void
    {
        if (!$delta) {
            return;
        }
        $db = self::db();
        $db->execute('INSERT INTO ' . self::t('stock') . ' (id_part, colour, qty) VALUES (' . $partId . ", '" . pSQL($colour) . "', " . $delta . ')
            ON DUPLICATE KEY UPDATE qty = qty + ' . $delta);
        $db->insert('onicprint_move', [
            'id_part' => $partId, 'colour' => pSQL($colour), 'delta' => $delta, 'reason' => pSQL($reason),
            'id_order' => (int) $idOrder, 'ref' => pSQL($ref), 'note' => pSQL(mb_substr($note, 0, 255)), 'date_add' => date('Y-m-d H:i:s'),
        ]);   // id_order 0 = not from an order
    }

    /** Set a part's on-hand count for a colour (a physical count). */
    public static function setStock(int $partId, string $colour, int $qty, string $note = ''): void
    {
        $cur = (int) self::db()->getValue('SELECT qty FROM ' . self::t('stock') . ' WHERE id_part = ' . $partId . " AND colour = '" . pSQL($colour) . "'");
        self::adjust($partId, $colour, $qty - $cur, 'count', null, '', $note ?: 'counted');
    }

    /** Printed parts arrive (the Pi's Complete). Idempotent per ref. */
    public static function addPrinted(int $partId, string $colour, int $qty, string $ref, string $note): array
    {
        if (!self::db()->getValue('SELECT 1 FROM ' . self::t('part') . ' WHERE id_part = ' . $partId)) {
            throw new Exception("Unknown part $partId");
        }
        if ($qty <= 0) {
            throw new Exception('qty must be positive');
        }
        if ($ref !== '' && self::db()->getValue('SELECT 1 FROM ' . self::t('move') . " WHERE reason = 'print' AND ref = '" . pSQL($ref) . "'")) {
            return ['already' => true, 'changes' => []];
        }
        self::adjust($partId, $colour, $qty, 'print', null, $ref, $note);

        return ['already' => false, 'changes' => self::recompute('printed: ' . $note)];
    }

    /**
     * Take up to $qty of a part for an item colour: that colour only; "any colour" takes
     * uncoloured parts first, then the most plentiful colour. Returns [[colour, n], ...] and the shortfall.
     */
    public static function take(array &$stock, int $partId, ?string $colour, int $qty): array
    {
        if ($colour !== null) {
            $keys = ["$partId|$colour"];
        } else {
            $others = array_filter(array_keys($stock), fn ($k) => strpos($k, "$partId|") === 0 && $k !== "$partId|");
            usort($others, fn ($a, $b) => ($stock[$b] ?? 0) <=> ($stock[$a] ?? 0));
            $keys = array_merge(["$partId|"], $others);
        }
        $from = [];
        $left = $qty;
        foreach ($keys as $k) {
            if ($left <= 0) {
                break;
            }
            $n = min(max(0, $stock[$k] ?? 0), $left);
            if ($n > 0) {
                $stock[$k] = ($stock[$k] ?? 0) - $n;
                $from[] = [substr($k, strlen("$partId|")), $n];
                $left -= $n;
            }
        }

        return [$from, $left];
    }

    // ------------------------------------------------------------------ orders

    private static function orderStatus(int $idOrder): ?string
    {
        $s = self::db()->getValue('SELECT status FROM ' . self::t('order') . ' WHERE id_order = ' . $idOrder);

        return $s === false ? null : (string) $s;
    }

    private static function setOrderStatus(int $idOrder, string $status): void
    {
        self::db()->execute('INSERT INTO ' . self::t('order') . " (id_order, status, date_upd) VALUES ($idOrder, '" . pSQL($status) . "', NOW())
            ON DUPLICATE KEY UPDATE status = VALUES(status), date_upd = NOW()");
    }

    /** A sale: take the parts of every managed item in the order off on hand (once per order). */
    public static function applyOrder(Order $order): array
    {
        $id = (int) $order->id;
        if (self::orderStatus($id) === 'deducted') {
            return [];
        }
        $stock = self::stockMap();
        $byKey = [];
        foreach (self::items($stock) as $i) {
            $byKey[$i['productId'] . '-' . $i['combinationId']] = $i;
        }
        $touched = false;
        foreach ($order->getProductsDetail() as $line) {
            $item = $byKey[(int) $line['product_id'] . '-' . (int) $line['product_attribute_id']] ?? null;
            if (!$item || !$item['managed'] || !$item['recipe']) {
                continue;
            }
            $sold = (int) $line['product_quantity'];
            foreach ($item['recipe'] as $r) {
                [$from, $short] = self::take($stock, $r['partId'], $item['colour'], $r['qty'] * $sold);
                $note = "{$order->reference}: {$sold}x {$item['label']}";
                foreach ($from as [$colour, $n]) {
                    self::adjust($r['partId'], $colour, -$n, 'sale', $id, 'order:' . $id, $note);
                }
                if ($short > 0) {   // sold more than the parts on hand (shared parts): goes negative, so it gets printed
                    self::adjust($r['partId'], (string) $item['colour'], -$short, 'sale', $id, 'order:' . $id, $note . ' (not on hand)');
                }
                $touched = true;
            }
        }
        if (!$touched) {
            return [];
        }
        self::setOrderStatus($id, 'deducted');

        return self::recompute('order ' . $order->reference);
    }

    /** A cancelled / refunded order: put back exactly what its sale took. */
    public static function reverseOrder(int $idOrder): array
    {
        if (self::orderStatus($idOrder) !== 'deducted') {
            return [];
        }
        $ref = (string) self::db()->getValue('SELECT reference FROM ' . _DB_PREFIX_ . 'orders WHERE id_order = ' . $idOrder);
        // What the order still holds: its sales minus anything already given back (cancel, un-cancel, cancel again).
        foreach (self::db()->executeS('SELECT id_part, colour, SUM(delta) d FROM ' . self::t('move') . " WHERE id_order = $idOrder AND reason IN ('sale','return') GROUP BY id_part, colour") ?: [] as $m) {
            if ((int) $m['d'] < 0) {
                self::adjust((int) $m['id_part'], $m['colour'], -(int) $m['d'], 'return', $idOrder, 'order:' . $idOrder, "$ref cancelled/refunded");
            }
        }
        self::setOrderStatus($idOrder, 'returned');

        return self::recompute("order $ref cancelled");
    }

    /** Order states after which the parts go back on hand. */
    public static function returnStates(): array
    {
        return array_filter(array_map('intval', [Configuration::get('PS_OS_CANCELED'), Configuration::get('PS_OS_REFUND'), Configuration::get('PS_OS_ERROR')]));
    }

    public static function onOrderState(int $idOrder, int $newState): array
    {
        $status = self::orderStatus($idOrder);
        if (in_array($newState, self::returnStates(), true)) {
            return $status === 'deducted' ? self::reverseOrder($idOrder) : [];
        }
        if ($status === 'returned') {   // un-cancelled: take the parts again
            self::setOrderStatus($idOrder, 'undone');
            $order = new Order($idOrder);

            return Validate::isLoadedObject($order) ? self::applyOrder($order) : [];
        }

        return [];
    }

    // ------------------------------------------------------------------ store quantities

    /**
     * Store quantity of every managed item with a recipe = sets buildable. Logged; written to the
     * store only in live mode or with $force (the owner's "Write to the store").
     *
     * @return array changes [{reference, label, before, after, written}]
     */
    public static function recompute(string $reason, bool $force = false, bool $preview = false): array
    {
        $write = !$preview && ($force || self::live());
        $changes = [];
        foreach (self::items() as $i) {
            if (!$i['managed'] || $i['buildable'] === null || $i['buildable'] === $i['storeQty']) {
                continue;
            }
            $c = ['productId' => $i['productId'], 'combinationId' => $i['combinationId'], 'reference' => $i['reference'],
                'label' => $i['label'], 'before' => $i['storeQty'], 'after' => $i['buildable'], 'written' => $write];
            if (!$preview) {
                // Log only: record an item again only when its number changes, not on every recompute.
                if (!$write && (string) self::db()->getValue('SELECT qty_after FROM ' . self::t('qty_log') . ' WHERE id_product = ' . $i['productId']
                    . ' AND id_product_attribute = ' . $i['combinationId'] . ' AND written = 0 ORDER BY id DESC') === (string) $i['buildable']) {
                    $changes[] = $c;
                    continue;
                }
                if ($write) {
                    StockAvailable::setQuantity($i['productId'], $i['combinationId'], $i['buildable']);
                }
                self::db()->insert('onicprint_qty_log', [
                    'id_product' => $i['productId'], 'id_product_attribute' => $i['combinationId'], 'reference' => pSQL($i['reference']),
                    'qty_before' => $i['storeQty'], 'qty_after' => $i['buildable'], 'written' => $write ? 1 : 0,
                    'reason' => pSQL(mb_substr($reason, 0, 128)), 'date_add' => date('Y-m-d H:i:s'),
                ]);
            }
            $changes[] = $c;
        }

        return $changes;
    }

    // ------------------------------------------------------------------ settings

    public static function saveItem(int $pid, int $cid, array $b): void
    {
        $cur = self::db()->getRow('SELECT * FROM ' . self::t('item') . " WHERE id_product = $pid AND id_product_attribute = $cid") ?: [
            'managed' => 0, 'min_qty' => 0, 'priority' => 0, 'print_colour' => '',
        ];
        $row = [
            'managed' => array_key_exists('managed', $b) ? ($b['managed'] ? 1 : 0) : (int) $cur['managed'],
            'min_qty' => array_key_exists('minQty', $b) ? max(0, min(100000, (int) $b['minQty'])) : (int) $cur['min_qty'],
            'priority' => array_key_exists('priority', $b) ? max(-1, min(1, (int) $b['priority'])) : (int) $cur['priority'],
            'print_colour' => pSQL(array_key_exists('printColour', $b) ? mb_substr((string) $b['printColour'], 0, 64) : (string) $cur['print_colour']),
        ];
        self::db()->execute('INSERT INTO ' . self::t('item') . " (id_product, id_product_attribute, managed, min_qty, priority, print_colour)
            VALUES ($pid, $cid, {$row['managed']}, {$row['min_qty']}, {$row['priority']}, '{$row['print_colour']}')
            ON DUPLICATE KEY UPDATE managed = VALUES(managed), min_qty = VALUES(min_qty), priority = VALUES(priority), print_colour = VALUES(print_colour)");
    }

    public static function saveRecipe(int $pid, int $cid, array $lines): void
    {
        $db = self::db();
        $db->delete('onicprint_recipe', "id_product = $pid AND id_product_attribute = $cid");
        foreach ($lines as $l) {
            $part = (int) ($l['partId'] ?? 0);
            $qty = (int) ($l['qty'] ?? 0);
            if ($part > 0 && $qty > 0) {
                $db->execute('INSERT INTO ' . self::t('recipe') . " (id_product, id_product_attribute, id_part, qty) VALUES ($pid, $cid, $part, $qty)
                    ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)");
            }
        }
    }

    public static function saveProduct(int $pid, bool $ignoreStoreColour): void
    {
        self::db()->execute('INSERT INTO ' . self::t('product') . " (id_product, ignore_store_colour) VALUES ($pid, " . ($ignoreStoreColour ? 1 : 0) . ')
            ON DUPLICATE KEY UPDATE ignore_store_colour = VALUES(ignore_store_colour)');
    }

    public static function savePart(?int $id, string $name, string $material, string $notes = ''): int
    {
        $name = trim($name);
        if ($name === '') {
            throw new Exception('A part needs a name.');
        }
        $dup = (int) self::db()->getValue('SELECT id_part FROM ' . self::t('part') . " WHERE name = '" . pSQL($name) . "'" . ($id ? " AND id_part <> $id" : ''));
        if ($dup) {
            throw new Exception("There is already a part called \"$name\".");
        }
        $row = ['name' => pSQL(mb_substr($name, 0, 128)), 'material' => pSQL(mb_substr(trim($material), 0, 32)), 'notes' => pSQL($notes)];
        if ($id) {
            self::db()->update('onicprint_part', $row, 'id_part = ' . $id);

            return $id;
        }
        self::db()->insert('onicprint_part', $row + ['date_add' => date('Y-m-d H:i:s')]);

        return (int) self::db()->Insert_ID();
    }

    public static function deletePart(int $id): void
    {
        $used = (int) self::db()->getValue('SELECT COUNT(*) FROM ' . self::t('recipe') . ' WHERE id_part = ' . $id);
        if ($used) {
            throw new Exception("This part is in $used recipe(s). Remove it from them first.");
        }
        self::db()->delete('onicprint_part', 'id_part = ' . $id);
        self::db()->delete('onicprint_stock', 'id_part = ' . $id);
    }

    // ------------------------------------------------------------------ history / import

    public static function history(int $limit = 200): array
    {
        $moves = self::db()->executeS('SELECT m.*, p.name AS part FROM ' . self::t('move') . ' m LEFT JOIN ' . self::t('part') . ' p ON p.id_part = m.id_part
            ORDER BY m.id_move DESC LIMIT ' . (int) $limit) ?: [];
        $qty = self::db()->executeS('SELECT * FROM ' . self::t('qty_log') . ' ORDER BY id DESC LIMIT ' . (int) $limit) ?: [];

        return ['moves' => $moves, 'quantities' => $qty];
    }

    /** One-time import of the Pi controller's inventory (parts keep their ids, so G-code files stay linked). */
    public static function import(array $d, bool $force): array
    {
        $db = self::db();
        if (!$force && (int) $db->getValue('SELECT COUNT(*) FROM ' . self::t('part'))) {
            throw new Exception('The module already has parts. Use force to replace them.');
        }
        foreach (['part', 'stock', 'item', 'product', 'recipe'] as $t) {
            $db->execute('DELETE FROM ' . self::t($t));
        }
        foreach ($d['parts'] ?? [] as $p) {
            $db->insert('onicprint_part', ['id_part' => (int) $p['id'], 'name' => pSQL($p['name']), 'material' => pSQL((string) ($p['material'] ?? '')),
                'notes' => pSQL((string) ($p['notes'] ?? '')), 'date_add' => date('Y-m-d H:i:s')]);
        }
        foreach ($d['stock'] ?? [] as $s) {
            if ((int) $s['qty']) {
                self::adjust((int) $s['partId'], (string) $s['colour'], (int) $s['qty'], 'import', null, '', 'from the Pi controller');
            }
        }
        foreach ($d['items'] ?? [] as $i) {
            self::saveItem((int) $i['productId'], (int) $i['combinationId'], [
                'managed' => !empty($i['managed']), 'minQty' => (int) ($i['minQty'] ?? 0), 'priority' => (int) ($i['priority'] ?? 0),
                'printColour' => (string) ($i['printColour'] ?? ''),
            ]);
            if (!empty($i['recipe'])) {
                self::saveRecipe((int) $i['productId'], (int) $i['combinationId'], $i['recipe']);
            }
        }
        foreach ($d['products'] ?? [] as $p) {
            self::saveProduct((int) $p['productId'], !empty($p['ignoreStoreColour']));
        }

        return ['parts' => count($d['parts'] ?? []), 'items' => count($d['items'] ?? []), 'stock' => count($d['stock'] ?? [])];
    }

    /** Everything the Pi controller needs to plan prints. */
    public static function state(): array
    {
        $stock = self::stockMap();
        $items = array_values(array_filter(self::items($stock), fn ($i) => $i['managed']));

        return ['live' => self::live(), 'at' => time(), 'parts' => self::parts(), 'stock' => self::stockList(),
            'colours' => self::storeColours(), 'items' => $items];
    }
}
