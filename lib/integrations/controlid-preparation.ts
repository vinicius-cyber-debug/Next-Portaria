/** Documentation references only. No Control iD transport/driver is registered. */
export const CONTROL_ID_PREPARATION={
  status:'awaiting_model_firmware_and_bench_validation',hardwareAdapterAvailable:false,physicalCommandsAvailable:false,
  models:['iDFace','iDBlock Next'],
  requiredEvidence:['exact_model','firmware_version','primary_secondary_topology','operation_mode_and_license','bench_read_only_validation'],
  documentation:{
    introduction:'https://www.controlid.com.br/docs/access-api-pt/',
    login:'https://www.controlid.com.br/docs/access-api-pt/gerenciamento-secao/fazer-login/',
    information:'https://www.controlid.com.br/docs/access-api-pt/sistema/obter-informacoes-do-sistema/',
    objects:'https://www.controlid.com.br/docs/access-api-pt/objetos/carregar-objetos/',
    idBlockNext:'https://www.controlid.com.br/docs/access-api-pt/particularidade-dos-produtos/idblock-next/',
    monitor:'https://www.controlid.com.br/docs/access-api-pt/monitor/introducao-ao-monitor/',
  },
} as const;
