<?php
if (!defined('_PS_VERSION_')) {
    exit;
}

/** 1.2.0: a colour per recipe line ('' = the item's colour, '*' = any colour, else that colour). */
function upgrade_module_1_2_0($module)
{
    $t = _DB_PREFIX_ . 'onicprint_recipe';
    $has = Db::getInstance()->executeS("SHOW COLUMNS FROM `$t` LIKE 'colour'");
    if (!$has) {
        return Db::getInstance()->execute("ALTER TABLE `$t` ADD COLUMN colour VARCHAR(64) NOT NULL DEFAULT '' AFTER qty");
    }

    return true;
}
