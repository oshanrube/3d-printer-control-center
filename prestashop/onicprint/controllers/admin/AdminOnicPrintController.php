<?php
if (!defined('_PS_VERSION_')) {
    exit;
}

require_once _PS_MODULE_DIR_ . 'onicprint/classes/OnicPrintInventory.php';

/** Catalog > Printed stock: one page (views/js/onicprint.js) talking JSON to this controller. */
class AdminOnicPrintController extends ModuleAdminController
{
    public function __construct()
    {
        $this->bootstrap = true;
        parent::__construct();
        $this->page_header_toolbar_title = 'Printed stock';
    }

    public function setMedia($isNewTheme = false)
    {
        parent::setMedia($isNewTheme);
        $this->addCSS($this->module->getPathUri() . 'views/css/onicprint.css?v=' . $this->module->version);
        $this->addJS($this->module->getPathUri() . 'views/js/onicprint.js?v=' . $this->module->version);
    }

    public function initContent()
    {
        parent::initContent();
        $this->context->smarty->assign([
            'onicprint_url' => $this->context->link->getAdminLink('AdminOnicPrint') . '&onicajax=1',
        ]);
        $this->content = $this->context->smarty->fetch(_PS_MODULE_DIR_ . 'onicprint/views/templates/admin/page.tpl');
        $this->context->smarty->assign('content', $this->content);
    }

    public function postProcess()
    {
        if (!Tools::getValue('onicajax')) {
            return parent::postProcess();
        }
        $op = (string) Tools::getValue('op');
        $b = json_decode((string) file_get_contents('php://input'), true) ?: [];
        try {
            $res = $this->handle($op, $b);
            $out = ['ok' => true] + $res;
        } catch (Throwable $e) {
            $out = ['ok' => false, 'error' => $e->getMessage()];
        }
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($out, JSON_UNESCAPED_UNICODE);
        exit;
    }

    private function state(array $extra = []): array
    {
        $stock = OnicPrintInventory::stockMap();

        return $extra + [
            'live' => OnicPrintInventory::live(),
            'items' => OnicPrintInventory::items($stock),
            'parts' => OnicPrintInventory::parts(),
            'stock' => OnicPrintInventory::stockList(),
            'colours' => OnicPrintInventory::storeColours(),
        ];
    }

    private function handle(string $op, array $b): array
    {
        $I = 'OnicPrintInventory';
        $after = fn (string $why) => $this->state(['changes' => OnicPrintInventory::recompute($why)]);
        switch ($op) {
            case 'state':
                return $this->state();
            case 'saveItem':
                $I::saveItem((int) $b['productId'], (int) $b['combinationId'], $b);

                return $after('item settings');
            case 'saveRecipe':
                $I::saveRecipe((int) $b['productId'], (int) $b['combinationId'], (array) ($b['lines'] ?? []));
                if (array_key_exists('printColour', $b)) {
                    $I::saveItem((int) $b['productId'], (int) $b['combinationId'], ['printColour' => (string) $b['printColour']]);
                }

                return $after('recipe');
            case 'saveProduct':
                $I::saveProduct((int) $b['productId'], !empty($b['ignoreStoreColour']));

                return $after('print colour rule');
            case 'savePart':
                $I::savePart(!empty($b['id']) ? (int) $b['id'] : null, (string) ($b['name'] ?? ''), (string) ($b['material'] ?? ''), (string) ($b['notes'] ?? ''));

                return $this->state();
            case 'deletePart':
                $I::deletePart((int) $b['id']);

                return $after('part deleted');
            case 'setStock':
                $I::setStock((int) $b['partId'], (string) ($b['colour'] ?? ''), max(0, (int) $b['qty']), 'counted by ' . $this->context->employee->firstname);

                return $after('parts counted');
            case 'preview':
                return ['changes' => $I::recompute('preview', false, true)];
            case 'apply':
                return $this->state(['changes' => $I::recompute('written by ' . $this->context->employee->firstname, true)]);
            case 'setLive':
                Configuration::updateValue(OnicPrintInventory::CONF_LIVE, !empty($b['live']) ? 1 : 0);

                return $this->state();
            case 'history':
                return $I::history(300);
        }
        throw new Exception("Unknown operation $op");
    }
}
