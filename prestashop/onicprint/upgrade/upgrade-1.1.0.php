<?php
if (!defined('_PS_VERSION_')) {
    exit;
}

/** 1.1.0: printed-stock fields (keep in stock, minimum, priority, colour, recipe) in the Edit combination dialog. */
function upgrade_module_1_1_0($module)
{
    return $module->registerHook('actionCombinationFormFormBuilderModifier')
        && $module->registerHook('actionAfterUpdateCombinationFormFormHandler');
}
