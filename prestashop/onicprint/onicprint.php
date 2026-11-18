<?php
/**
 * Onic Print: printed-parts inventory for store.onicindustries.com.
 *
 * Parts on hand (per colour) are the inventory; each managed store item's quantity is the number of
 * full sets they allow (recipe = parts x qty). Sales take parts off, cancellations put them back.
 * The printer controller (Raspberry/Orange Pi at home) reads what's needed through the webservice
 * resource "onicprint" and reports printed parts back.
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

require_once __DIR__ . '/classes/OnicPrintInventory.php';
require_once __DIR__ . '/classes/WebserviceSpecificManagementOnicprint.php';

class OnicPrint extends Module
{
    public const TAB_CLASS = 'AdminOnicPrint';

    public function __construct()
    {
        $this->name = 'onicprint';
        $this->tab = 'administration';
        $this->version = '1.1.0';
        $this->author = 'Oshan Rube';
        $this->need_instance = 0;
        $this->ps_versions_compliancy = ['min' => '8.0.0', 'max' => _PS_VERSION_];
        $this->bootstrap = true;
        parent::__construct();
        $this->displayName = $this->l('Printed stock');
        $this->description = $this->l('Printed parts on hand, recipes and minimum stock; store quantities follow the parts on hand. Feeds the 3D printer controller.');
        $this->confirmUninstall = $this->l('Uninstalling deletes the parts, recipes and stock history. Continue?');
    }

    public function install()
    {
        return parent::install()
            && $this->installDb()
            && $this->installTab()
            && $this->registerHook('actionValidateOrder')
            && $this->registerHook('actionOrderStatusPostUpdate')
            && $this->registerHook('addWebserviceResources')
            && $this->registerHook('actionCombinationFormFormBuilderModifier')
            && $this->registerHook('actionAfterUpdateCombinationFormFormHandler')
            && Configuration::updateValue(OnicPrintInventory::CONF_LIVE, 0)
            && $this->grantWebservice();
    }

    public function uninstall()
    {
        $id = (int) Tab::getIdFromClassName(self::TAB_CLASS);
        if ($id) {
            (new Tab($id))->delete();
        }
        foreach (['part', 'stock', 'item', 'product', 'recipe', 'move', 'order', 'qty_log'] as $t) {
            Db::getInstance()->execute('DROP TABLE IF EXISTS `' . OnicPrintInventory::t($t) . '`');
        }
        Db::getInstance()->delete('webservice_permission', "resource = 'onicprint'");
        Configuration::deleteByName(OnicPrintInventory::CONF_LIVE);

        return parent::uninstall();
    }

    private function installDb(): bool
    {
        $e = 'ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8mb4';
        $t = fn ($n) => '`' . OnicPrintInventory::t($n) . '`';
        $sql = [
            "CREATE TABLE IF NOT EXISTS {$t('part')} (id_part INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(128) NOT NULL,
                material VARCHAR(32) NOT NULL DEFAULT '', notes TEXT, date_add DATETIME NOT NULL, PRIMARY KEY (id_part), UNIQUE KEY name (name)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('stock')} (id_part INT UNSIGNED NOT NULL, colour VARCHAR(64) NOT NULL DEFAULT '', qty INT NOT NULL DEFAULT 0,
                PRIMARY KEY (id_part, colour)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('item')} (id_product INT UNSIGNED NOT NULL, id_product_attribute INT UNSIGNED NOT NULL,
                managed TINYINT(1) NOT NULL DEFAULT 0, min_qty INT NOT NULL DEFAULT 0, priority TINYINT NOT NULL DEFAULT 0,
                print_colour VARCHAR(64) NOT NULL DEFAULT '', PRIMARY KEY (id_product, id_product_attribute)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('product')} (id_product INT UNSIGNED NOT NULL, ignore_store_colour TINYINT(1) NOT NULL DEFAULT 0,
                PRIMARY KEY (id_product)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('recipe')} (id_product INT UNSIGNED NOT NULL, id_product_attribute INT UNSIGNED NOT NULL,
                id_part INT UNSIGNED NOT NULL, qty INT NOT NULL DEFAULT 1, PRIMARY KEY (id_product, id_product_attribute, id_part)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('move')} (id_move INT UNSIGNED NOT NULL AUTO_INCREMENT, id_part INT UNSIGNED NOT NULL,
                colour VARCHAR(64) NOT NULL DEFAULT '', delta INT NOT NULL, reason VARCHAR(32) NOT NULL, id_order INT UNSIGNED NULL,
                ref VARCHAR(64) NOT NULL DEFAULT '', note VARCHAR(255) NOT NULL DEFAULT '', date_add DATETIME NOT NULL,
                PRIMARY KEY (id_move), KEY id_order (id_order), KEY ref (ref)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('order')} (id_order INT UNSIGNED NOT NULL, status VARCHAR(16) NOT NULL, date_upd DATETIME NOT NULL,
                PRIMARY KEY (id_order)) $e",
            "CREATE TABLE IF NOT EXISTS {$t('qty_log')} (id INT UNSIGNED NOT NULL AUTO_INCREMENT, id_product INT UNSIGNED NOT NULL,
                id_product_attribute INT UNSIGNED NOT NULL, reference VARCHAR(64) NOT NULL DEFAULT '', qty_before INT NOT NULL, qty_after INT NOT NULL,
                written TINYINT(1) NOT NULL, reason VARCHAR(128) NOT NULL DEFAULT '', date_add DATETIME NOT NULL, PRIMARY KEY (id)) $e",
        ];
        foreach ($sql as $q) {
            if (!Db::getInstance()->execute($q)) {
                return false;
            }
        }

        return true;
    }

    private function installTab(): bool
    {
        if ((int) Tab::getIdFromClassName(self::TAB_CLASS)) {
            return true;
        }
        $tab = new Tab();
        $tab->active = 1;
        $tab->class_name = self::TAB_CLASS;
        $tab->module = $this->name;
        $tab->icon = 'print';
        $tab->id_parent = (int) Tab::getIdFromClassName('AdminCatalog');
        $tab->name = [];
        foreach (Language::getLanguages(true) as $lang) {
            $tab->name[$lang['id_lang']] = 'Printed stock';
        }

        return (bool) $tab->add();
    }

    /** Give GET + POST on "onicprint" to webservice keys that may already write stock (the printer controller). */
    private function grantWebservice(): bool
    {
        $ids = Db::getInstance()->executeS('SELECT DISTINCT id_webservice_account FROM ' . _DB_PREFIX_ . "webservice_permission
            WHERE resource = 'stock_availables' AND method = 'PUT'") ?: [];
        foreach ($ids as $r) {
            foreach (['GET', 'POST', 'HEAD'] as $m) {
                Db::getInstance()->execute('INSERT IGNORE INTO ' . _DB_PREFIX_ . 'webservice_permission (resource, method, id_webservice_account)
                    VALUES (\'onicprint\', \'' . $m . '\', ' . (int) $r['id_webservice_account'] . ')');
            }
        }

        return true;
    }

    public function getContent()
    {
        Tools::redirectAdmin($this->context->link->getAdminLink(self::TAB_CLASS));
    }

    public function hookAddWebserviceResources($params)
    {
        return ['onicprint' => ['description' => 'Printed stock: parts, recipes, queue for the 3D printer controller', 'specific_management' => true]];
    }

    // ------------------------------------------------------------------ Edit combination dialog

    private const RECIPE_ROWS_MIN = 4;

    /** Adds a "Printed stock" section to Catalog > Product > Combinations > Edit. */
    public function hookActionCombinationFormFormBuilderModifier($params)
    {
        $this->safely('combination form', function () use ($params) {
            $cid = (int) ($params['id'] ?? 0);
            if (!$cid) {
                return;
            }
            $pid = (int) (new Combination($cid))->id_product;
            $item = null;
            foreach (OnicPrintInventory::items() as $i) {
                if ($i['productId'] === $pid && $i['combinationId'] === $cid) {
                    $item = $i;
                    break;
                }
            }
            if (!$item) {
                return;
            }
            $T = 'Symfony\Component\Form\Extension\Core\Type\\';
            $parts = [];
            foreach (OnicPrintInventory::parts() as $p) {
                $parts[$p['name'] . ($p['material'] ? ' (' . $p['material'] . ')' : '')] = $p['id'];
            }
            $colours = ['Any colour' => ''];
            foreach (OnicPrintInventory::storeColours() as $c) {
                $colours[$c] = $c;
            }
            $usesStoreColour = $item['hasStoreColour'] && !$item['ignoreStoreColour'];
            $builder = $params['form_builder'];
            $builder->add('onicprint', $T . 'FormType', [
                'label' => 'Printed stock', 'required' => false,
                'help' => 'Store quantity = full sets the printed parts on hand allow'
                    . ($item['buildable'] !== null ? ' (now ' . $item['buildable'] . ')' : '') . '. Catalog > Printed stock has every item and the parts on hand.',
            ]);
            $f = $builder->get('onicprint');
            $f->add('managed', $T . 'CheckboxType', ['label' => 'Keep this combination in stock with printed parts', 'required' => false, 'data' => $item['managed']]);
            $f->add('min_qty', $T . 'IntegerType', ['label' => 'Minimum in stock', 'required' => false, 'data' => $item['minQty'], 'attr' => ['min' => 0]]);
            $f->add('priority', $T . 'ChoiceType', ['label' => 'Print priority', 'required' => true, 'data' => $item['priority'],
                'choices' => ['High' => 1, 'Normal' => 0, 'Low' => -1]]);
            $f->add('print_colour', $T . 'ChoiceType', ['label' => 'Print in', 'required' => false, 'data' => $item['printColour'], 'choices' => $colours,
                'help' => $usesStoreColour ? 'Not used: this combination is printed in its store colour (' . $item['storeColour'] . ').' : 'This combination has no colour of its own (or the product ignores it).']);
            $rows = max(self::RECIPE_ROWS_MIN, count($item['recipe']) + 2);
            for ($n = 1; $n <= $rows; ++$n) {
                $line = $item['recipe'][$n - 1] ?? null;
                $f->add('part_' . $n, $T . 'ChoiceType', ['label' => $n === 1 ? 'Recipe: printed parts in one item' : false, 'required' => false,
                    'placeholder' => '- no part -', 'choices' => $parts, 'data' => $line ? $line['partId'] : null]);
                $f->add('qty_' . $n, $T . 'IntegerType', ['label' => false, 'required' => false, 'data' => $line ? $line['qty'] : null,
                    'attr' => ['min' => 1, 'placeholder' => 'qty']]);
            }
        });
    }

    public function hookActionAfterUpdateCombinationFormFormHandler($params)
    {
        $this->safely('combination save', function () use ($params) {
            $d = $params['form_data']['onicprint'] ?? null;
            $cid = (int) ($params['id'] ?? 0);
            if (!is_array($d) || !$cid) {
                return;
            }
            $pid = (int) (new Combination($cid))->id_product;
            OnicPrintInventory::saveItem($pid, $cid, [
                'managed' => !empty($d['managed']), 'minQty' => (int) ($d['min_qty'] ?? 0),
                'priority' => (int) ($d['priority'] ?? 0), 'printColour' => (string) ($d['print_colour'] ?? ''),
            ]);
            $lines = [];
            foreach ($d as $k => $v) {
                if (preg_match('/^part_(\d+)$/', $k, $m) && (int) $v > 0) {
                    $lines[] = ['partId' => (int) $v, 'qty' => max(1, (int) ($d['qty_' . $m[1]] ?? 1))];
                }
            }
            OnicPrintInventory::saveRecipe($pid, $cid, $lines);
            OnicPrintInventory::recompute('combination edited');
        });
    }

    /** Never let our bookkeeping break checkout: log and carry on. */
    private function safely(string $what, callable $fn): void
    {
        try {
            $fn();
        } catch (Throwable $e) {
            PrestaShopLogger::addLog('onicprint ' . $what . ': ' . $e->getMessage(), 3, null, 'Module', (int) $this->id);
        }
    }

    public function hookActionValidateOrder($params)
    {
        $this->safely('order', function () use ($params) {
            if (!empty($params['order']) && $params['order'] instanceof Order) {
                OnicPrintInventory::applyOrder($params['order']);
            }
        });
    }

    public function hookActionOrderStatusPostUpdate($params)
    {
        $this->safely('order state', function () use ($params) {
            $state = $params['newOrderStatus'] ?? null;
            if (!empty($params['id_order']) && $state) {
                OnicPrintInventory::onOrderState((int) $params['id_order'], (int) (is_object($state) ? $state->id : $state));
            }
        });
    }
}
