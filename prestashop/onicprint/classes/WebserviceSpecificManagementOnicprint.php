<?php
/**
 * Webservice resource /api/onicprint for the printer controller (works in maintenance mode, uses
 * the controller's existing webservice key; the key needs GET and POST on "onicprint").
 *
 *   GET  /api/onicprint?action=state                     parts, stock per colour, managed items (buildable, recipe, min, priority)
 *   GET  /api/onicprint?action=history                   stock moves and store quantity changes
 *   POST /api/onicprint?action=complete  {partId, colour, qty, ref, note}   printed parts arrive (idempotent per ref)
 *   POST /api/onicprint?action=import    {parts, stock, items, products, force}   one-time import from the controller
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

require_once __DIR__ . '/OnicPrintInventory.php';

class WebserviceSpecificManagementOnicprint implements WebserviceSpecificManagementInterface
{
    /** @var WebserviceOutputBuilder */
    protected $objOutput;
    /** @var WebserviceRequest */
    protected $wsObject;
    protected $output = '';

    public function setObjectOutput(WebserviceOutputBuilder $obj)
    {
        $this->objOutput = $obj;

        return $this;
    }

    public function getObjectOutput()
    {
        return $this->objOutput;
    }

    public function setWsObject(WebserviceRequest $obj)
    {
        $this->wsObject = $obj;

        return $this;
    }

    public function getWsObject()
    {
        return $this->wsObject;
    }

    public function manage()
    {
        $method = $this->wsObject->method;
        $action = (string) Tools::getValue('action', 'state');
        try {
            if ($method === 'GET' && $action === 'state') {
                $result = OnicPrintInventory::state();
            } elseif ($method === 'GET' && $action === 'history') {
                $result = OnicPrintInventory::history((int) Tools::getValue('limit', 100));
            } elseif ($method === 'POST' && $action === 'complete') {
                $b = $this->body();
                $result = OnicPrintInventory::addPrinted((int) ($b['partId'] ?? 0), (string) ($b['colour'] ?? ''), (int) ($b['qty'] ?? 0),
                    (string) ($b['ref'] ?? ''), (string) ($b['note'] ?? ''));
            } elseif ($method === 'POST' && $action === 'import') {
                $b = $this->body();
                $result = OnicPrintInventory::import($b, !empty($b['force']));
            } else {
                throw new Exception("Unknown action $method $action");
            }
            $this->output = json_encode(['ok' => true] + $result, JSON_UNESCAPED_UNICODE);
        } catch (Throwable $e) {
            $this->output = json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        header('Content-Type: application/json; charset=utf-8');
    }

    private function body(): array
    {
        $b = json_decode((string) file_get_contents('php://input'), true);
        if (!is_array($b)) {
            throw new Exception('Send a JSON body.');
        }

        return $b;
    }

    public function getContent()
    {
        return $this->output;
    }
}
