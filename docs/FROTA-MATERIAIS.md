# Frota própria e saída de materiais

## Demonstração rápida

Em **Saída de materiais**, use **Registrar saída de material** para informar descrição, quantidade, destino, responsável e número da nota fiscal existente, quando houver. Placa e observações complementam o registro. A busca encontra também a nota fiscal.

Em **Frota própria**, cadastre o veículo com placa, descrição e quilometragem inicial. Registre a saída com motorista, destino, finalidade e leitura do hodômetro. No retorno, informe a nova leitura e as condições encontradas. O histórico conserva horários, operadores, leituras e distância percorrida.

As vistorias possuem álbuns separados de **saída** e **retorno**, com envio e visualização privada de imagens e vídeos. O envio reutiliza a retomada e a política de retenção das mídias: imagens PNG/JPEG/WebP até 10 MiB, vídeos MP4/WebM até 256 MiB. O álbum de saída recebe arquivos durante a viagem aberta; o de retorno, após o registro de retorno.

## Regras da primeira entrega

- Uma única viagem aberta por veículo da empresa.
- Quilometragem inteira, sem retroceder em relação à leitura anterior. O retorno não pode ser menor que a saída.
- Cadastro de frota própria separado dos veículos de visitantes e terceiros.
- Registro transacional, controle de concorrência e histórico de quem executou cada ação.
- Operações disponíveis aos perfis autorizados com a permissão de gerenciar ocorrências; a consulta dos arquivos e da nota fiscal exige a permissão de documentos. Consulta não concede permissão de escrita.

## Atualização

Preserve e verifique um backup antes de aplicar a migração `007_fleet_media.sql`. A migração mantém as mídias de ocorrências existentes e adiciona o vínculo por fase das vistorias. As novas coleções operacionais são `fleetTrips` e `materialExits`; snapshots antigos são aceitos com essas listas vazias. Não há alteração de permissões físicas nas catracas.

## Verificação local de 19/11/2026

A suíte completa aprovou 370 testes, sem casos ignorados. Após a revisão final, nove testes focados de logística e mídias foram repetidos com sucesso, incluindo a proteção contra edição pelo cadastro legado. Tipagem, lint, formatação e compilação nativa foram aprovados.

O teste de navegador com PostgreSQL isolado cadastrou o veículo, registrou saída com 1.200 km e foto, retorno com 1.234 km e vídeo MP4 privado reproduzido, e uma saída de material com NF 123456. A distância calculada foi 34 km. Os registros permaneceram após recarregar; seis capturas desktop/mobile terminaram sem erros de navegador nem transbordamento da página. Nenhum desses registros fictícios foi inserido na base operacional.

A instalação local recebeu a migração após backup recuperado e verificado de 45 tabelas, 649 arquivos e 650 referências. O acesso HTTPS foi conferido com certificado validado. O destino externo de backup continua pendente.
